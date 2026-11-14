import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents.ts";
import { buildChildArgs, remainingDepth, resolveModel } from "../src/launch.ts";
import { cleanupOldSessions, RETENTION_MS } from "../src/sessions.ts";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-unit-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("discoverAgents", () => {
	it("ships scout and worker builtins", () => {
		const agents = discoverAgents(path.join(root, "missing"));
		expect(agents.map((a) => a.name).sort()).toEqual(["scout", "worker"]);
		expect(agents.every((a) => a.source === "builtin" && !a.model && !a.thinking)).toBe(true);
	});

	it("lets user agents override builtins and add new ones", () => {
		fs.writeFileSync(
			path.join(root, "scout.md"),
			"---\nname: scout\ndescription: mine\nmodel: x/y\nthinking: high\ntools: [read]\n---\nprompt",
		);
		fs.writeFileSync(path.join(root, "reviewer.md"), "---\nname: reviewer\ndescription: r\n---\n");
		fs.writeFileSync(path.join(root, "broken.md"), "---\nname: [\n---\n");
		const agents = discoverAgents(root);
		const scout = agents.find((a) => a.name === "scout")!;
		expect(scout).toMatchObject({ source: "user", description: "mine", model: "x/y", thinking: "high", tools: ["read"] });
		expect(agents.map((a) => a.name).sort()).toEqual(["reviewer", "scout", "worker"]);
	});
});

describe("remainingDepth", () => {
	it("defaults to 1 and reads the env var", () => {
		expect(remainingDepth({})).toBe(1);
		expect(remainingDepth({ PI_SUBAGENT_DEPTH: "0" })).toBe(0);
		expect(remainingDepth({ PI_SUBAGENT_DEPTH: "3" })).toBe(3);
		expect(remainingDepth({ PI_SUBAGENT_DEPTH: "junk" })).toBe(1);
	});
});

describe("resolveModel", () => {
	const registry = {
		find: (p: string, id: string) => (p === "a" && id === "m1" ? { provider: "a", id: "m1" } : undefined),
		getAll: () => [{ provider: "b", id: "m2" }],
	};
	it("inherits the parent model when unspecified", () => {
		expect(resolveModel(undefined, registry, "p/x")).toEqual({ model: "p/x" });
	});
	it("resolves provider/id and bare id", () => {
		expect(resolveModel("a/m1", registry, "p/x")).toEqual({ model: "a/m1" });
		expect(resolveModel("m2", registry, "p/x")).toEqual({ model: "b/m2" });
	});
	it("falls back to the parent with a warning", () => {
		const r = resolveModel("claude-haiku-5-5", registry, "p/x");
		expect(r.model).toBe("p/x");
		expect(r.warning).toContain("claude-haiku-5-5");
	});
});

describe("buildChildArgs", () => {
	it("omits unset options", () => {
		const args = buildChildArgs({
			agent: { name: "w", description: "", systemPrompt: "", source: "builtin" },
			task: "t",
			sessionId: "id1",
			sessionDir: "/s",
		});
		expect(args).toEqual(["--mode", "json", "-p", "--session-dir", "/s", "--session-id", "id1", "Task: t"]);
	});
});

describe("cleanupOldSessions", () => {
	it("removes files older than 7 days except active runs", () => {
		const now = Date.now();
		const old = (now - RETENTION_MS - 1000) / 1000;
		fs.mkdirSync(path.join(root, "meta"));
		const files = {
			oldSession: path.join(root, "t_old.jsonl"),
			oldMeta: path.join(root, "meta", "old.json"),
			activeSession: path.join(root, "t_active.jsonl"),
			freshSession: path.join(root, "t_fresh.jsonl"),
		};
		for (const f of Object.values(files)) fs.writeFileSync(f, "");
		for (const f of [files.oldSession, files.oldMeta, files.activeSession]) fs.utimesSync(f, old, old);

		const removed = cleanupOldSessions(root, new Set(["active"]), now);
		expect(removed.sort()).toEqual([files.oldMeta, files.oldSession].sort());
		expect(fs.existsSync(files.activeSession)).toBe(true);
		expect(fs.existsSync(files.freshSession)).toBe(true);
	});
});
