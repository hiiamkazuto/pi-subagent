/**
 * Child session storage: run metadata, result extraction from session JSONL,
 * and age-based cleanup.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunMeta {
	id: string;
	agent: string;
	cwd: string;
	createdAt: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface RunResult {
	/** 1-based index of the latest run (= number of user prompts in the session). */
	runIndex: number;
	output: string;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageTotals;
	turns: number;
}

const metaDir = (sessionDir: string) => path.join(sessionDir, "meta");
const metaPath = (sessionDir: string, id: string) => path.join(metaDir(sessionDir), `${id}.json`);

export function writeMeta(sessionDir: string, meta: RunMeta): void {
	fs.mkdirSync(metaDir(sessionDir), { recursive: true });
	fs.writeFileSync(metaPath(sessionDir, meta.id), JSON.stringify(meta));
}

export function readMeta(sessionDir: string, id: string): RunMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(metaPath(sessionDir, id), "utf-8")) as RunMeta;
	} catch {
		return undefined;
	}
}

function* walkJsonl(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonl(p);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield p;
	}
}

/** Session files are named `<timestamp>_<id>.jsonl`, possibly grouped in subdirectories. */
export function findSessionFile(sessionDir: string, id: string): string | undefined {
	for (const file of walkJsonl(sessionDir)) {
		if (path.basename(file).endsWith(`_${id}.jsonl`)) return file;
	}
	return undefined;
}

export function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: UsageTotals, u: Partial<UsageTotals> | undefined): void {
	if (!u) return;
	total.input += u.input ?? 0;
	total.output += u.output ?? 0;
	total.cacheRead += u.cacheRead ?? 0;
	total.cacheWrite += u.cacheWrite ?? 0;
	total.totalTokens += u.totalTokens ?? 0;
	total.cost.input += u.cost?.input ?? 0;
	total.cost.output += u.cost?.output ?? 0;
	total.cost.cacheRead += u.cost?.cacheRead ?? 0;
	total.cost.cacheWrite += u.cost?.cacheWrite ?? 0;
	total.cost.total += u.cost?.total ?? 0;
}

interface SessionMessage {
	role: string;
	content?: unknown;
	usage?: Partial<UsageTotals>;
	stopReason?: string;
	errorMessage?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
}

/**
 * Extract the latest run from a session file: everything after the last user
 * message. Usage is summed over that run only, so resumed sessions are not
 * double counted.
 */
export function readLatestRun(sessionFile: string): RunResult | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return undefined;
	}
	const messages: SessionMessage[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "message" && entry.message?.role) messages.push(entry.message);
		} catch {
			// partial trailing line
		}
	}
	let runIndex = 0;
	let start = -1;
	messages.forEach((m, i) => {
		if (m.role === "user") {
			runIndex++;
			start = i;
		}
	});
	if (start < 0) return undefined;

	const result: RunResult = { runIndex, output: "", usage: emptyUsage(), turns: 0 };
	for (const m of messages.slice(start + 1)) {
		if (m.role !== "assistant") continue;
		result.turns++;
		addUsage(result.usage, m.usage);
		result.stopReason = m.stopReason;
		result.errorMessage = m.errorMessage;
		const text = textOf(m.content);
		if (text.trim()) result.output = text;
	}
	return result;
}

/** Delete session and meta files not modified within `maxAgeMs`, except active runs. */
export function cleanupOldSessions(
	sessionDir: string,
	activeIds: Set<string>,
	now: number = Date.now(),
	maxAgeMs: number = RETENTION_MS,
): string[] {
	const removed: string[] = [];
	const isActive = (file: string) => {
		const base = path.basename(file).replace(/\.(jsonl|json)$/, "");
		for (const id of activeIds) if (base === id || base.endsWith(`_${id}`)) return true;
		return false;
	};
	const candidates = [...walkJsonl(sessionDir)];
	try {
		for (const f of fs.readdirSync(metaDir(sessionDir))) {
			if (f.endsWith(".json")) candidates.push(path.join(metaDir(sessionDir), f));
		}
	} catch {
		// no meta dir yet
	}
	for (const file of candidates) {
		if (isActive(file)) continue;
		try {
			if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
				fs.unlinkSync(file);
				removed.push(file);
			}
		} catch {
			// raced with another deletion
		}
	}
	return removed;
}
