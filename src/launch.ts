/**
 * Pure helpers for launching a child pi process: depth control, model
 * resolution, and CLI argument construction.
 */

import type { AgentConfig } from "./agents.ts";

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/** Remaining subagent levels for this process. Unset means 1. */
export function remainingDepth(env: NodeJS.ProcessEnv): number {
	const raw = env[DEPTH_ENV];
	if (raw === undefined || raw.trim() === "") return 1;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : 1;
}

export interface ModelLookup {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	getAll(): { provider: string; id: string }[];
}

export interface ResolvedModel {
	/** `provider/id` to pass to --model, or undefined to let pi use its default. */
	model?: string;
	warning?: string;
}

/**
 * Resolve the agent's model spec. Omitted spec inherits the parent model.
 * An unknown spec falls back to the parent model with a warning.
 */
export function resolveModel(spec: string | undefined, registry: ModelLookup, parentModel?: string): ResolvedModel {
	if (!spec) return { model: parentModel };
	const slash = spec.indexOf("/");
	const found =
		slash > 0
			? registry.find(spec.slice(0, slash), spec.slice(slash + 1))
			: registry.getAll().find((m) => m.id === spec);
	if (found) return { model: `${found.provider}/${found.id}` };
	return {
		model: parentModel,
		warning: `Model "${spec}" not found; using parent model ${parentModel ?? "(default)"}.`,
	};
}

export interface ChildArgsInput {
	agent: AgentConfig;
	task: string;
	sessionId: string;
	sessionDir: string;
	model?: string;
	thinking?: string;
	systemPromptFile?: string;
}

export function buildChildArgs(input: ChildArgsInput): string[] {
	const args = ["--mode", "json", "-p", "--session-dir", input.sessionDir, "--session-id", input.sessionId];
	if (input.model) args.push("--model", input.model);
	if (input.thinking) args.push("--thinking", input.thinking);
	if (input.agent.tools?.length) args.push("--tools", input.agent.tools.join(","));
	if (input.systemPromptFile) args.push("--append-system-prompt", input.systemPromptFile);
	args.push(`Task: ${input.task}`);
	return args;
}
