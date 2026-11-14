/**
 * Agent discovery: built-in agents shipped with this package, overridden or
 * extended by user agents in ~/.pi/agent/agents/*.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** `provider/model-id` or bare model id. Omitted: inherit parent. */
	model?: string;
	/** Thinking level. Omitted: inherit parent. */
	thinking?: string;
	systemPrompt: string;
	source: "builtin" | "user";
	filePath: string;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: parseToolList(frontmatter.tools),
				model: optionalString(frontmatter.model),
				thinking: optionalString(frontmatter.thinking),
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// One broken file must not hide the other agents.
		}
	}
	return agents;
}

/** Built-in agents first; user agents with the same name replace them. */
export function discoverAgents(userDir: string, builtinDir: string = BUILTIN_AGENTS_DIR): AgentConfig[] {
	const map = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(builtinDir, "builtin")) map.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(userDir, "user")) map.set(agent.name, agent);
	return Array.from(map.values());
}
