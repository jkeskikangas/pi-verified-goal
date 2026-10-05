// Workspace evidence computed by the harness, never by the agent: tree snapshots, diffs, verify runs.

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RunResult {
	exitCode: number;
	output: string;
	timedOut: boolean;
}

/** Run a process, keeping the tail of combined stdout/stderr. Never rejects. */
export function run(
	command: string,
	args: string[],
	opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxOutput?: number; input?: string },
): Promise<RunResult> {
	const maxOutput = opts.maxOutput ?? 200_000;
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		const append = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > maxOutput * 2) output = output.slice(-maxOutput);
		};
		const proc = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		const kill = () => {
			try {
				// Negative pid kills the whole process group, so shells take their children with them.
				if (proc.pid) process.kill(-proc.pid, "SIGTERM");
			} catch {
				proc.kill("SIGTERM");
			}
		};
		const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : undefined;
		opts.signal?.addEventListener("abort", kill, { once: true });
		proc.stdout.on("data", append);
		proc.stderr.on("data", append);
		proc.stdin.end(opts.input ?? "");
		const done = (exitCode: number) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", kill);
			resolve({ exitCode, output: output.length > maxOutput ? `…(truncated)\n${output.slice(-maxOutput)}` : output, timedOut });
		};
		proc.on("error", (err) => {
			output += String(err);
			done(127);
		});
		proc.on("close", (code, sig) => done(code ?? (sig ? 128 : 1)));
	});
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	const r = await run("git", args, { cwd, env: env && { ...process.env, ...env }, timeoutMs: 60_000, maxOutput: 5_000_000 });
	return r.exitCode === 0 ? r.output : undefined;
}

/**
 * Snapshot the working tree (tracked changes and untracked, non-ignored files) as a git tree id.
 * Uses a private copy of the index, so the user's staging area is untouched. Undefined outside git.
 */
export async function snapshotTree(cwd: string): Promise<string | undefined> {
	const indexPath = (await git(cwd, ["rev-parse", "--git-path", "index"]))?.trim();
	if (!indexPath) return undefined;
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	const tmpIndex = join(dir, "index");
	try {
		// Seeding from the real index lets git reuse its stat cache instead of rehashing every file.
		await copyFile(isAbsolute(indexPath) ? indexPath : join(cwd, indexPath), tmpIndex).catch(() => {});
		const env = { GIT_INDEX_FILE: tmpIndex };
		if ((await git(cwd, ["add", "-A", "--", "."], env)) === undefined) return undefined;
		return (await git(cwd, ["write-tree"], env))?.trim() || undefined;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const MAX_DIFF = 120_000;

/** Diff between two tree snapshots: a stat summary, then the patch, truncated. */
export async function treeDiff(cwd: string, from: string, to: string): Promise<string> {
	const stat = (await git(cwd, ["diff", "--stat=200", from, to])) ?? "";
	const patch = (await git(cwd, ["diff", "--no-color", "--no-ext-diff", from, to])) ?? "";
	const body = patch.length > MAX_DIFF ? `${patch.slice(0, MAX_DIFF)}\n…(diff truncated; read the files directly)` : patch;
	return `${stat.trim()}\n\n${body}`.trim();
}

const VERIFY_TIMEOUT_MS = 30 * 60_000;

export async function runVerify(cwd: string, command: string, signal?: AbortSignal): Promise<RunResult> {
	return run("/bin/sh", ["-c", command], { cwd, signal, timeoutMs: VERIFY_TIMEOUT_MS, maxOutput: 20_000 });
}
