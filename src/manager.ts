/**
 * Background run registry. Independent of the pi extension API so it can be
 * driven directly from tests.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { buildChildArgs, DEPTH_ENV, type ModelLookup, resolveModel } from "./launch.ts";
import { type ChildHandle, type ChildOutcome, getPiInvocation, spawnChild } from "./runner.ts";
import {
	cleanupOldSessions,
	findSessionFile,
	readLatestRun,
	readMeta,
	type RunResult,
	writeMeta,
} from "./sessions.ts";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface Run {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	warning?: string;
	errorMessage?: string;
	handle?: ChildHandle;
}

export interface StartRequest {
	agent?: string;
	task: string;
	cwd: string;
	resume?: string;
	parentModel?: string;
	parentThinking?: string;
	models: ModelLookup;
}

export interface ResultView {
	id: string;
	agent: string;
	status: RunStatus;
	elapsedMs: number;
	run?: RunResult;
	sessionFile?: string;
	errorMessage?: string;
	warning?: string;
}

export interface ManagerOptions {
	sessionDir: string;
	userAgentsDir: string;
	/** Remaining depth of *this* process; children get one less. */
	depth: number;
	env?: NodeJS.ProcessEnv;
	invoke?: (args: string[]) => { command: string; args: string[] };
	onFinish?: (run: Run) => void;
	onChange?: () => void;
	now?: () => number;
}

export class SubagentManager {
	private runs = new Map<string, Run>();
	private readonly now: () => number;

	constructor(private readonly opts: ManagerOptions) {
		this.now = opts.now ?? Date.now;
	}

	agents(): AgentConfig[] {
		return discoverAgents(this.opts.userAgentsDir);
	}

	list(): Run[] {
		return [...this.runs.values()];
	}

	runningCount(): number {
		return this.list().filter((r) => r.status === "running").length;
	}

	/** Start a child in the background. Returns the run, or an error message. */
	start(req: StartRequest): Run | string {
		let id: string;
		let agentName: string;
		let cwd: string;
		if (req.resume) {
			id = req.resume;
			if (this.runs.get(id)?.status === "running") return `Subagent ${id} is still running; cannot resume.`;
			const meta = readMeta(this.opts.sessionDir, id);
			if (!meta) return `Unknown subagent session: ${id}`;
			agentName = meta.agent;
			cwd = meta.cwd;
		} else {
			if (!req.agent) return "Parameter 'agent' is required unless 'resume' is given.";
			id = randomUUID();
			agentName = req.agent;
			cwd = req.cwd;
		}

		const agents = this.agents();
		const agent = agents.find((a) => a.name === agentName);
		if (!agent) {
			const available = agents.map((a) => a.name).join(", ") || "none";
			return `Unknown agent "${agentName}". Available: ${available}`;
		}

		const { model, warning } = resolveModel(agent.model, req.models, req.parentModel);
		const thinking = agent.thinking ?? req.parentThinking;

		let promptFile: string | undefined;
		if (agent.systemPrompt.trim()) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
			promptFile = path.join(dir, "prompt.md");
			fs.writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
		}

		fs.mkdirSync(this.opts.sessionDir, { recursive: true });
		writeMeta(this.opts.sessionDir, { id, agent: agent.name, cwd, createdAt: this.now() });

		const args = buildChildArgs({
			agent,
			task: req.task,
			sessionId: id,
			sessionDir: this.opts.sessionDir,
			model,
			thinking,
			systemPromptFile: promptFile,
		});
		const invocation = (this.opts.invoke ?? getPiInvocation)(args);
		const env = { ...(this.opts.env ?? process.env), [DEPTH_ENV]: String(this.opts.depth - 1) };

		const run: Run = {
			id,
			agent: agent.name,
			task: req.task,
			cwd,
			status: "running",
			startedAt: this.now(),
			warning,
		};
		run.handle = spawnChild({ command: invocation.command, args: invocation.args, cwd, env });
		this.runs.set(id, run);
		this.opts.onChange?.();

		void run.handle.done.then((outcome) => {
			if (promptFile) fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
			this.settle(run, outcome);
		});
		return run;
	}

	/** Resolves when the run has settled (test helper / internal). */
	async wait(id: string): Promise<Run | undefined> {
		const run = this.runs.get(id);
		if (run?.handle) await run.handle.done;
		await new Promise((r) => setImmediate(r));
		return run;
	}

	private settle(run: Run, outcome: ChildOutcome): void {
		run.endedAt = this.now();
		run.handle = undefined;
		const latest = this.latestRun(run.id);
		if (outcome.stopped) {
			run.status = "stopped";
			run.errorMessage = "Stopped";
		} else if (outcome.spawnError) {
			run.status = "failed";
			run.errorMessage = `Failed to spawn subagent: ${outcome.spawnError}`;
		} else if (outcome.code !== 0) {
			run.status = "failed";
			run.errorMessage = describeExit(outcome);
		} else if (latest?.stopReason === "error" || latest?.stopReason === "aborted") {
			run.status = "failed";
			run.errorMessage = latest.errorMessage ?? `Subagent stopped: ${latest.stopReason}`;
		} else {
			run.status = "completed";
		}
		// Runs asynchronously after exit: a throwing callback must not crash the host.
		for (const cb of [() => this.opts.onChange?.(), () => this.opts.onFinish?.(run)]) {
			try {
				cb();
			} catch {
				// host context may be gone (reload / shutdown)
			}
		}
	}

	private latestRun(id: string): RunResult | undefined {
		const file = findSessionFile(this.opts.sessionDir, id);
		return file ? readLatestRun(file) : undefined;
	}

	/** Result view for a run, falling back to the stored session after a restart. */
	result(id: string): ResultView | undefined {
		const sessionFile = findSessionFile(this.opts.sessionDir, id);
		const latest = sessionFile ? readLatestRun(sessionFile) : undefined;
		const run = this.runs.get(id);
		if (run) {
			return {
				id,
				agent: run.agent,
				status: run.status,
				elapsedMs: (run.endedAt ?? this.now()) - run.startedAt,
				run: run.status === "running" ? undefined : latest,
				sessionFile,
				errorMessage: run.errorMessage,
				warning: run.warning,
			};
		}
		const meta = readMeta(this.opts.sessionDir, id);
		if (!meta || !sessionFile || !latest) return undefined;
		const failed = latest.stopReason === "error" || latest.stopReason === "aborted";
		return {
			id,
			agent: meta.agent,
			status: failed ? "failed" : "completed",
			elapsedMs: 0,
			run: latest,
			sessionFile,
			errorMessage: failed ? latest.errorMessage : undefined,
		};
	}

	stop(id: string): boolean {
		const run = this.runs.get(id);
		if (!run?.handle || run.status !== "running") return false;
		run.handle.stop();
		return true;
	}

	stopAll(): void {
		for (const run of this.runs.values()) run.handle?.stop();
	}

	cleanup(): string[] {
		const active = new Set(this.list().filter((r) => r.status === "running").map((r) => r.id));
		return cleanupOldSessions(this.opts.sessionDir, active, this.now());
	}
}

function describeExit(o: ChildOutcome): string {
	const head = o.signal ? `Subagent terminated by signal ${o.signal}` : `Subagent exited with code ${o.code}`;
	const tail = o.stderr.trim();
	return tail ? `${head}\n${tail}` : head;
}

/** Key identifying one run's usage, so the same run is never counted twice. */
export const usageKey = (id: string, runIndex: number) => `${id}#${runIndex}`;

/** True if a previous subagent_result tool result in the session already carried this usage. */
export function isUsageAccounted(entries: readonly unknown[], key: string): boolean {
	return entries.some((e) => {
		const entry = e as { type?: string; message?: { role?: string; details?: { usageKey?: string } } };
		return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.details?.usageKey === key;
	});
}
