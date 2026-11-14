#!/usr/bin/env node
// Stand-in for `pi --mode json -p --session-dir D --session-id ID ... "Task: ..."`.
// Behaviour is driven by the task text:
//   "fail"  -> exit 1 with stderr
//   "sleep" -> hang until killed
//   "error" -> assistant message with stopReason "error"
//   other   -> reply "done: <task> depth=<PI_SUBAGENT_DEPTH>" with usage
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const dir = opt("--session-dir");
const id = opt("--session-id");
const task = args[args.length - 1];

fs.writeFileSync(path.join(dir, `args-${id}.txt`), JSON.stringify(args));

if (task.includes("fail")) {
	process.stderr.write("boom: something broke\n");
	process.exit(1);
}

const existing = fs.readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
const file = path.join(dir, existing ?? `2026-01-01T00-00-00-000Z_${id}.jsonl`);
const write = (o) => fs.appendFileSync(file, `${JSON.stringify(o)}\n`);
if (!existing) write({ type: "session", version: 3, id, cwd: process.cwd() });
write({ type: "message", message: { role: "user", content: task } });

if (task.includes("sleep")) {
	setInterval(() => {}, 1000);
} else {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
	const isError = task.includes("error");
	write({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `done: ${task} depth=${process.env.PI_SUBAGENT_DEPTH} cwd=${process.cwd()}` }],
			usage,
			stopReason: isError ? "error" : "stop",
			errorMessage: isError ? "provider exploded" : undefined,
		},
	});
}
