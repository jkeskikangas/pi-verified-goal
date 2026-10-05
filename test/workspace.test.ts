import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runVerify, snapshotTree, treeDiff } from "../src/workspace.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
	const d = mkdtempSync(join(tmpdir(), "goal-ws-"));
	dirs.push(d);
	const git = (...a: string[]) => execFileSync("git", a, { cwd: d });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(d, "a.txt"), "one\n");
	writeFileSync(join(d, ".gitignore"), "ignored.log\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return d;
}

test("snapshots cover untracked files, skip ignored ones, and leave the index alone", async () => {
	const d = repo();
	const indexBefore = readFileSync(join(d, ".git", "index"));
	const t0 = await snapshotTree(d);
	assert.ok(t0);
	assert.equal(await snapshotTree(d), t0, "unchanged worktree gives the same fingerprint");

	writeFileSync(join(d, "ignored.log"), "noise");
	assert.equal(await snapshotTree(d), t0, "ignored files do not count as progress");

	writeFileSync(join(d, "new.ts"), "export const x = 1;\n");
	writeFileSync(join(d, "a.txt"), "two\n");
	const t1 = await snapshotTree(d);
	assert.notEqual(t1, t0);
	assert.deepEqual(readFileSync(join(d, ".git", "index")), indexBefore, "user's staging area untouched");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d }).toString(), " M a.txt\n?? new.ts\n");

	const diff = await treeDiff(d, t0!, t1!);
	assert.match(diff, /new\.ts/);
	assert.match(diff, /\+export const x = 1;/);
	assert.match(diff, /-one\n\+two/);
});

test("snapshot is undefined outside git", async () => {
	const d = mkdtempSync(join(tmpdir(), "goal-nogit-"));
	dirs.push(d);
	assert.equal(await snapshotTree(d), undefined);
});

test("runVerify reports exit codes and output, and can be aborted", async () => {
	const d = repo();
	const ok = await runVerify(d, "echo hi && test -f a.txt");
	assert.deepEqual([ok.exitCode, ok.output.trim()], [0, "hi"]);
	const bad = await runVerify(d, "echo boom >&2; exit 3");
	assert.deepEqual([bad.exitCode, bad.output.trim()], [3, "boom"]);

	const ac = new AbortController();
	const started = Date.now();
	const pending = runVerify(d, "sleep 30 & sleep 30; wait", ac.signal);
	setTimeout(() => ac.abort(), 200);
	const aborted = await pending;
	assert.notEqual(aborted.exitCode, 0);
	assert.ok(Date.now() - started < 5000, "abort kills the whole process group");
});
