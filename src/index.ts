/**
 * pi-subagent: delegate tasks to background subagents running in separate
 * `pi` processes.
 *
 * Tools: subagent, subagent_status, subagent_result, subagent_stop.
 * Inspired by pi's examples/extensions/subagent (pi v1.5.2).
 */

import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { remainingDepth } from "./launch.ts";
import { isUsageAccounted, type Run, SubagentManager, usageKey } from "./manager.ts";

const SUMMARY_CHARS = 200;
const STATUS_KEY = "subagent";
const MESSAGE_TYPE = "subagent";

const text = (t: string) => [{ type: "text" as const, text: t }];

function formatElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function summarize(output: string | undefined): string {
	const flat = (output ?? "").replace(/\s+/g, " ").trim();
	return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat;
}

export default function (pi: ExtensionAPI) {
	const depth = remainingDepth(process.env);
	if (depth < 1) return;

	const agentDir = getAgentDir();
	let uiCtx: ExtensionContext | undefined;
	let shuttingDown = false;

	const updateStatus = () => {
		if (shuttingDown || !uiCtx?.hasUI) return;
		const n = manager.runningCount();
		uiCtx.ui.setStatus(STATUS_KEY, n > 0 ? `subagents: ${n} running` : undefined);
	};

	const notify = (run: Run) => {
		if (shuttingDown) return;
		const view = manager.result(run.id);
		const icon = run.status === "completed" ? "✓" : "✗";
		const detail =
			run.status === "completed" ? summarize(view?.run?.output) : summarize(run.errorMessage ?? run.status);
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: `${icon} subagent ${run.agent} ${run.id} ${run.status}: ${detail}\n(Use subagent_result to read the full output.)`,
				display: true,
				details: { id: run.id, agent: run.agent, status: run.status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const manager = new SubagentManager({
		sessionDir: path.join(agentDir, "subagent-sessions"),
		userAgentsDir: path.join(agentDir, "agents"),
		depth,
		onChange: updateStatus,
		onFinish: notify,
	});

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		shuttingDown = false;
		manager.cleanup();
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		// ctx goes stale after shutdown; children settling later must not touch it.
		shuttingDown = true;
		uiCtx = undefined;
		manager.stopAll();
	});

	const accounted = new Set<string>();

	const agentList = manager
		.agents()
		.map((a) => `- ${a.name}: ${a.description}`)
		.join("\n");

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Start a subagent in the background with its own isolated context. Returns an id immediately;",
			"you will be notified when it finishes, then read its output with subagent_result.",
			"Call this tool several times to run subagents in parallel.",
			"Pass `resume` with a previous id to continue that subagent's session with a new task.",
			`Available agents:\n${agentList || "(none)"}`,
		].join(" "),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent name (required unless resume is given)" })),
			task: Type.String({ description: "Task to delegate" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			resume: Type.Optional(Type.String({ description: "Id of a previous subagent session to continue" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const result = manager.start({
				agent: params.agent,
				task: params.task,
				cwd: path.resolve(ctx.cwd, params.cwd ?? "."),
				resume: params.resume,
				parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				parentThinking: ctx.thinkingLevel,
				models: ctx.modelRegistry,
			});
			if (typeof result === "string") return { content: text(result), details: undefined, isError: true };
			const lines = [`Started subagent ${result.agent} (id: ${result.id}).`];
			if (result.warning) lines.push(`Warning: ${result.warning}`);
			return { content: text(lines.join("\n")), details: { id: result.id, agent: result.agent } };
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "List subagents started in this session and their status.",
		parameters: Type.Object({}),
		async execute() {
			const runs = manager.list();
			if (runs.length === 0) return { content: text("No subagents."), details: undefined };
			const now = Date.now();
			const lines = runs.map(
				(r) => `${r.id} ${r.agent} ${r.status} ${formatElapsed((r.endedAt ?? now) - r.startedAt)} — ${summarize(r.task)}`,
			);
			return { content: text(lines.join("\n")), details: undefined };
		},
	});

	pi.registerTool({
		name: "subagent_result",
		label: "Subagent Result",
		description: "Read the output of a finished subagent. For running subagents, returns the current status.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent id" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const view = manager.result(params.id);
			if (!view) return { content: text(`Unknown subagent: ${params.id}`), details: undefined, isError: true };
			if (view.status === "running") {
				return {
					content: text(`Subagent ${view.id} (${view.agent}) is still running (${formatElapsed(view.elapsedMs)}).`),
					details: undefined,
				};
			}

			const parts: string[] = [`Subagent ${view.id} (${view.agent}) ${view.status}.`];
			if (view.warning) parts.push(`Warning: ${view.warning}`);
			if (view.errorMessage) parts.push(`Error: ${view.errorMessage}`);
			const output = view.run?.output ?? "";
			if (output) {
				const t = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 5 });
				parts.push(t.content);
				if (t.truncated) parts.push(`[Output truncated. Full session: ${view.sessionFile}]`);
			} else {
				parts.push("(no output)");
			}

			// Attach this run's usage to the parent's totals exactly once.
			let key: string | undefined;
			let usage: NonNullable<typeof view.run>["usage"] | undefined;
			if (view.run) {
				const candidate = usageKey(view.id, view.run.runIndex);
				if (!accounted.has(candidate) && !isUsageAccounted(ctx.sessionManager.getEntries(), candidate)) {
					accounted.add(candidate);
					key = candidate;
					usage = view.run.usage;
				}
			}
			return {
				content: text(parts.join("\n\n")),
				details: key ? { usageKey: key } : undefined,
				usage,
				isError: view.status !== "completed",
			};
		},
	});
	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Stop a running subagent. Partial output stays readable with subagent_result, and it can be continued later with subagent resume.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent id" }) }),
		async execute(_id, params) {
			const ok = manager.stop(params.id);
			return ok
				? { content: text(`Stopping subagent ${params.id}.`), details: undefined }
				: { content: text(`No running subagent with id ${params.id}.`), details: undefined, isError: true };
		},
	});
}
