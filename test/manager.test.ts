import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUsageAccounted, type Run, SubagentManager, usageKey } from "../src/manager.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const models = { find: () => undefined, getAll: () => [] };

let root: string;
let finished: Run[];
let manager: SubagentManager;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	fs.mkdirSync(path.join(root, "agents"));
	finished = [];
	manager = new SubagentManager({
		sessionDir: path.join(root, "sessions"),
		userAgentsDir: path.join(root, "agents"),
		depth: 1,
		invoke: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
		onFinish: (run) => finished.push({ ...run }),
	});
});

afterEach(() => {
	manager.cancelAll();
	fs.rmSync(root, { recursive: true, force: true });
});

function start(req: { agent?: string; task: string; resume?: string }) {
	const run = manager.start({ cwd: root, models, parentModel: "p/m", parentThinking: "low", ...req });
	if (typeof run === "string") throw new Error(run);
	return run;
}

describe("SubagentManager", () => {
	it("runs a builtin agent in the background and reads its result from the session", async () => {
		const run = start({ agent: "scout", task: "find things" });
		expect(run.status).toBe("running");
		expect(manager.runningCount()).toBe(1);

		await manager.wait(run.id);
		expect(finished.map((r) => r.status)).toEqual(["completed"]);
		const view = manager.result(run.id)!;
		expect(view.status).toBe("completed");
		expect(view.run?.output).toContain("done: Task: find things depth=0");
		expect(view.run?.usage.cost.total).toBeCloseTo(0.03);
		expect(view.run?.runIndex).toBe(1);
	});

	it("passes inherited model/thinking, tools and session id to the child", async () => {
		const run = start({ agent: "scout", task: "x" });
		await manager.wait(run.id);
		const args = JSON.parse(fs.readFileSync(path.join(root, "sessions", `args-${run.id}.txt`), "utf-8"));
		expect(args).toEqual(expect.arrayContaining(["--model", "p/m", "--thinking", "low", "--session-id", run.id]));
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash");
	});

	it("reports non-zero exit as failed with stderr tail", async () => {
		const run = start({ agent: "worker", task: "please fail" });
		await manager.wait(run.id);
		expect(finished[0].status).toBe("failed");
		expect(finished[0].errorMessage).toContain("boom: something broke");
	});

	it("reports provider errors as failed", async () => {
		const run = start({ agent: "worker", task: "error" });
		await manager.wait(run.id);
		expect(finished[0].status).toBe("failed");
		expect(finished[0].errorMessage).toBe("provider exploded");
	});

	it("cancels a running child", async () => {
		const run = start({ agent: "worker", task: "sleep" });
		expect(manager.result(run.id)?.status).toBe("running");
		expect(manager.cancel(run.id)).toBe(true);
		await manager.wait(run.id);
		expect(finished[0].status).toBe("cancelled");
		expect(manager.cancel(run.id)).toBe(false);
	});

	it("resumes a session; latest run usage only counts that run", async () => {
		const first = start({ agent: "scout", task: "one" });
		await manager.wait(first.id);
		const second = start({ resume: first.id, task: "two" });
		expect(second.id).toBe(first.id);
		expect(second.agent).toBe("scout");
		await manager.wait(second.id);
		const view = manager.result(first.id)!;
		expect(view.run?.runIndex).toBe(2);
		expect(view.run?.output).toContain("Task: two");
		expect(view.run?.usage.cost.total).toBeCloseTo(0.03);
	});

	it("refuses to resume a running session or an unknown one", () => {
		const run = start({ agent: "worker", task: "sleep" });
		expect(manager.start({ cwd: root, models, resume: run.id, task: "x" })).toMatch(/still running/);
		expect(manager.start({ cwd: root, models, resume: "nope", task: "x" })).toMatch(/Unknown subagent session/);
	});

	it("rejects unknown agents", () => {
		expect(manager.start({ cwd: root, models, agent: "ghost", task: "x" })).toMatch(/Available: scout, worker/);
	});

	it("recovers results from disk after a restart", async () => {
		const run = start({ agent: "scout", task: "persist" });
		await manager.wait(run.id);
		const fresh = new SubagentManager({
			sessionDir: path.join(root, "sessions"),
			userAgentsDir: path.join(root, "agents"),
			depth: 1,
		});
		const view = fresh.result(run.id)!;
		expect(view.status).toBe("completed");
		expect(view.agent).toBe("scout");
		expect(view.run?.output).toContain("persist");
	});

	it("survives callbacks that throw after the host ctx went stale", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		let armed = false;
		const stale = () => {
			if (armed) throw new Error("ctx is stale");
		};
		const m = new SubagentManager({
			sessionDir: path.join(root, "sessions"),
			userAgentsDir: path.join(root, "agents"),
			depth: 1,
			invoke: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
			onChange: stale,
			onFinish: stale,
		});
		const run = m.start({ cwd: root, models, agent: "scout", task: "x" });
		if (typeof run === "string") throw new Error(run);
		armed = true;
		await m.wait(run.id);
		await new Promise((r) => setTimeout(r, 20));
		process.off("unhandledRejection", onUnhandled);
		expect(unhandled).toEqual([]);
		expect(m.result(run.id)?.status).toBe("completed");
	});

	it("does not launch children that would exceed depth", async () => {
		const deep = new SubagentManager({
			sessionDir: path.join(root, "sessions"),
			userAgentsDir: path.join(root, "agents"),
			depth: 3,
			invoke: (args) => ({ command: process.execPath, args: [FAKE_PI, ...args] }),
		});
		const run = deep.start({ cwd: root, models, agent: "scout", task: "d" });
		if (typeof run === "string") throw new Error(run);
		await deep.wait(run.id);
		expect(deep.result(run.id)?.run?.output).toContain("depth=2");
	});
});

describe("usage accounting", () => {
	it("detects a previous subagent_result carrying the same key", () => {
		const key = usageKey("abc", 2);
		const entries = [
			{ type: "message", message: { role: "toolResult", details: { usageKey: usageKey("abc", 1) } } },
			{ type: "custom", data: {} },
		];
		expect(isUsageAccounted(entries, key)).toBe(false);
		entries.push({ type: "message", message: { role: "toolResult", details: { usageKey: key } } });
		expect(isUsageAccounted(entries, key)).toBe(true);
	});
});
