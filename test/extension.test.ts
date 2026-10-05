// Drives the extension through a fake pi host: the same event, tool and command surface pi calls.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AuditResult } from "../src/audit.ts";
import { goalExtension } from "../src/index.ts";
import type { AuditInput } from "../src/prompts.ts";
import { ENTRY_TYPE, type Goal } from "../src/state.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
	const d = mkdtempSync(join(tmpdir(), "goal-ext-"));
	dirs.push(d);
	execFileSync("sh", ["-c", "git init -q && git config user.email t@t && git config user.name t && echo a > a.txt && git add . && git commit -qm init"], { cwd: d });
	return d;
}

type Handler = (event: any, ctx: any) => Promise<any>;

function host(opts: { audits?: AuditResult[]; confirm?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const sent: any[] = [];
	const notes: string[] = [];
	const auditInputs: AuditInput[] = [];
	const audits = [...(opts.audits ?? [])];
	const cwd = repo();
	const pi: any = {
		on: (name: string, h: Handler) => handlers.set(name, h),
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (name: string, c: any) => commands.set(name, c),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (m: any, o: any) => sent.push({ ...m, ...o }),
	};
	const ctx: any = {
		cwd,
		hasUI: true,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		sessionManager: { getBranch: () => entries },
		ui: { setStatus: () => {}, notify: (m: string) => notes.push(m), confirm: async () => opts.confirm ?? true },
	};
	goalExtension(pi, {
		runAudit: async (input) => {
			auditInputs.push(input);
			return audits.shift() ?? { verdict: "error", report: "no audit scripted", tokens: 0 };
		},
	});
	const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
	const goal = (): Goal | null => [...entries].reverse().find((e) => e.customType === ENTRY_TYPE)?.data.goal ?? null;
	const settle = (outcome = "completed", pending: unknown[] = []) => emit("agent_before_settle", { outcome, context: { pendingMessages: pending } });
	const callTool = (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx);
	const command = (args: string) => commands.get("goal").handler(args, ctx);
	const touch = (content: string) => writeFileSync(join(cwd, "work.txt"), content);
	return { emit, goal, settle, callTool, command, touch, entries, sent, notes, auditInputs, ctx };
}

const approved: AuditResult = { verdict: "approved", report: "ok\nVERDICT: APPROVED", tokens: 100 };
const rejected: AuditResult = { verdict: "rejected", report: "missing X\nVERDICT: REJECTED", tokens: 100 };

test("/goal starts a goal and kicks off a hidden turn", async () => {
	const h = host();
	await h.command("--verify true Ship it");
	const g = h.goal()!;
	assert.equal(g.status, "active");
	assert.equal(g.objective, "Ship it");
	assert.ok(g.baseline, "baseline snapshot taken");
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].triggerTurn, true);
	assert.match(h.sent[0].content, new RegExp(`goal_id "${g.id}"`));
});

test("continues at settle, and steps aside for queued user input", async () => {
	const h = host();
	await h.command("obj");
	h.touch("1");
	const r = await h.settle();
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].type, "custom_message");
	assert.match(r.entries[0].content, /Continue working toward the active goal/);
	assert.equal(h.goal()!.continuations, 1);
	assert.equal(await h.settle("completed", [{ role: "user" }]), undefined);
	assert.equal(h.goal()!.continuations, 1);
});

test("Esc pauses; provider errors block with a classified reason", async () => {
	const h = host();
	await h.command("obj");
	await h.emit("turn_end", { outcome: "aborted" });
	assert.equal(await h.settle("aborted"), undefined);
	await h.emit("agent_settled");
	assert.deepEqual([h.goal()!.status, h.goal()!.reason], ["paused", "interrupted"]);

	await h.command("resume");
	await h.emit("agent_start");
	await h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429 usage limit reached", usage: { input: 5, output: 5, cacheWrite: 0 } } });
	await h.emit("turn_end", { outcome: "error" });
	await h.emit("agent_settled");
	assert.equal(h.goal()!.status, "blocked");
	assert.match(h.goal()!.reason!, /^provider usage limit/);
});

test("pauses after N runs with no workspace change", async () => {
	const h = host();
	await h.command("--idle 2 obj");
	assert.equal((await h.settle()).continue, true); // first observation
	assert.equal((await h.settle()).continue, true); // idle 1
	assert.equal(await h.settle(), undefined); // idle 2 -> stall
	assert.equal(h.goal()!.status, "paused");
	assert.match(h.goal()!.reason!, /no workspace changes in 2/);
});

test("run cap: one wrap-up turn, tools blocked, then stop", async () => {
	const h = host();
	await h.command("--turns 1 obj");
	h.touch("1");
	assert.equal((await h.settle()).continue, true);
	h.touch("2");
	const wrap = await h.settle();
	assert.equal(wrap.continue, true);
	assert.match(wrap.entries[0].content, /continuation cap reached/);
	assert.equal(h.goal()!.status, "limited");
	assert.deepEqual(await h.emit("tool_call", { toolName: "bash" }), { block: true, reason: "The goal budget is exhausted. Do not use tools; summarize progress and stop." });
	assert.equal(await h.emit("tool_call", { toolName: "goal_complete" }), undefined);
	assert.equal(await h.settle(), undefined);
	await h.emit("agent_settled");
	assert.equal(h.goal()!.status, "limited", "settle does not overwrite a limit");
});

test("token budget trips mid-run at turn_end and excludes cache reads", async () => {
	const h = host();
	await h.command("--tokens 1k obj");
	await h.emit("message_end", { message: { role: "assistant", usage: { input: 100, output: 100, cacheRead: 50_000, cacheWrite: 0 } } });
	assert.equal(await h.emit("turn_end", { outcome: "completed" }), undefined);
	await h.emit("message_end", { message: { role: "assistant", usage: { input: 700, output: 200, cacheRead: 50_000, cacheWrite: 0 } } });
	const r = await h.emit("turn_end", { outcome: "completed" });
	assert.match(r.entries[0].content, /token budget reached \(1100 of 1000\)/);
	assert.equal(h.goal()!.status, "limited");
	assert.equal(await h.settle(), undefined, "wrap-up already delivered in-run");
});

test("verify gate: failure keeps the goal active; success completes", async () => {
	const h = host();
	await h.command(`--no-audit --verify "test -f done.txt" obj`);
	const id = h.goal()!.id;
	const fail = await h.callTool("goal_complete", { goal_id: id, summary: "done" });
	assert.match(fail.content[0].text, /Not accepted: `test -f done.txt` exited 1/);
	assert.equal(fail.terminate, false);
	assert.equal(h.goal()!.status, "active");
	writeFileSync(join(h.ctx.cwd, "done.txt"), "");
	const ok = await h.callTool("goal_complete", { goal_id: id, summary: "done" });
	assert.equal(ok.terminate, true);
	assert.equal(h.goal()!.status, "complete");
	assert.equal(await h.settle(), undefined);
});

test("stale or wrong goal ids are refused", async () => {
	const h = host();
	await h.command("obj");
	await assert.rejects(h.callTool("goal_complete", { goal_id: "nope", summary: "s" }), /No active goal/);
	await assert.rejects(h.callTool("goal_blocked", { goal_id: "nope", reason: "r" }), /No active goal/);
});

test("auditor: harness evidence, rejection feedback, approval", async () => {
	const h = host({ audits: [rejected, approved] });
	await h.command("--verify true obj");
	const id = h.goal()!.id;
	h.touch("new work");
	const r1 = await h.callTool("goal_complete", { goal_id: id, summary: "claim" });
	assert.match(r1.content[0].text, /Auditor rejected completion \(1\/3\)/);
	assert.equal(h.goal()!.rejections, 1);
	const first = h.auditInputs[0];
	assert.equal(first.objective, "obj");
	assert.equal(first.verify?.exitCode, 0);
	assert.match(first.diff, /work\.txt/, "diff computed by the harness, includes untracked files");
	assert.equal(first.previousFindings, undefined);

	const r2 = await h.callTool("goal_complete", { goal_id: id, summary: "claim 2" });
	assert.equal(r2.terminate, true);
	assert.equal(h.auditInputs[1].previousFindings, rejected.report);
	assert.equal(h.goal()!.status, "complete");
	assert.equal(h.goal()!.tokens, 200, "auditor tokens count toward the goal");
});

test("auditor: repeated rejections block; a broken auditor pauses instead of looping", async () => {
	const h = host({ audits: [rejected, rejected, rejected] });
	await h.command("obj");
	const id = h.goal()!.id;
	for (let i = 0; i < 3; i++) await h.callTool("goal_complete", { goal_id: id, summary: "s" });
	assert.equal(h.goal()!.status, "blocked");

	const h2 = host({ audits: [{ verdict: "missing", report: "rambling", tokens: 1 }, { verdict: "missing", report: "rambling", tokens: 1 }] });
	await h2.command("obj");
	const r = await h2.callTool("goal_complete", { goal_id: h2.goal()!.id, summary: "s" });
	assert.equal(h2.auditInputs.length, 2, "one retry on a missing verdict");
	assert.equal(r.terminate, true);
	assert.equal(h2.goal()!.status, "paused");
	assert.match(h2.goal()!.reason!, /auditor unavailable/);
});

test("restoring a session never auto-runs a goal", async () => {
	const h = host();
	await h.command("obj");
	await h.emit("session_start", { reason: "resume" });
	assert.equal(h.goal()!.status, "paused");
	assert.match(h.goal()!.reason!, /session resume/);
	assert.equal(await h.settle(), undefined);
});

test("replacing needs confirmation; clear removes the goal", async () => {
	const h = host({ confirm: false });
	await h.command("first");
	await h.command("second");
	assert.equal(h.goal()!.objective, "first");
	assert.match(h.notes.at(-1)!, /Kept the current goal/);
	await h.command("pause");
	await h.command("clear");
	assert.equal(h.goal(), null);
});
