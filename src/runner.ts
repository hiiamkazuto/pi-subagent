/**
 * Child process lifecycle. Stdout (JSON events) is discarded: the result is
 * read from the persisted session file after exit. Only stderr's tail is kept
 * for failure diagnostics.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 5000;

export interface ChildOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: string;
	stderr: string;
	stopped: boolean;
}

export interface ChildHandle {
	done: Promise<ChildOutcome>;
	stop(): void;
}

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export function spawnChild(spec: SpawnSpec): ChildHandle {
	let stderr = "";
	let stopped = false;
	let exited = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let proc: ReturnType<typeof spawn> | undefined;

	const done = new Promise<ChildOutcome>((resolve) => {
		let settled = false;
		const finish = (o: Omit<ChildOutcome, "stderr" | "stopped">) => {
			if (settled) return;
			settled = true;
			exited = true;
			if (killTimer) clearTimeout(killTimer);
			resolve({ ...o, stderr, stopped });
		};
		try {
			proc = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				shell: false,
				stdio: ["ignore", "ignore", "pipe"],
			});
		} catch (error) {
			finish({ code: null, signal: null, spawnError: String(error instanceof Error ? error.message : error) });
			return;
		}
		proc.stderr?.on("data", (d) => {
			stderr = (stderr + d.toString()).slice(-STDERR_TAIL);
		});
		proc.on("close", (code, signal) => finish({ code, signal }));
		proc.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
	});

	return {
		done,
		stop() {
			if (exited || !proc || stopped) return;
			stopped = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!exited) proc?.kill("SIGKILL");
			}, KILL_GRACE_MS);
			killTimer.unref?.();
		},
	};
}

/** How to re-invoke the running pi binary (adapted from pi's subagent example). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}
