import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAudit } from "./audit.ts";
import { continuationPrompt, kickoffPrompt, wrapUpPrompt } from "./prompts.ts";
import {
	billableTokens,
	classifyError,
	createGoal,
	ENTRY_TYPE,
	exhaustedBudget,
	type Goal,
	type GoalEntry,
	type GoalStatus,
	latestGoal,
	observeProgress,
	parseGoalArgs,
	resume,
	statusLine,
	transition,
} from "./state.ts";
import { runVerify, snapshotTree, treeDiff } from "./workspace.ts";

const MESSAGE_TYPE = "verified-goal-prompt";
const GOAL_TOOLS = new Set(["goal_complete", "goal_blocked"]);
const USAGE = `Usage:
  /goal [--tokens 500k] [--time 2h] [--turns 30] [--idle 5] [--verify "<cmd>"] [--no-audit] [--audit-model provider/id] <objective>
  /goal status | pause | resume | clear`;

export interface GoalDeps {
	runAudit: typeof runAudit;
}

export default function (pi: ExtensionAPI) {
	goalExtension(pi, { runAudit });
}

export function goalExtension(pi: ExtensionAPI, deps: GoalDeps) {
	let goal: Goal | undefined;
	/** Outcome of the latest turn in the current run: completed, aborted or error. */
	let lastOutcome: "completed" | "aborted" | "error" = "completed";
	let lastError: string | undefined;
	let previousFindings: string | undefined;

	const now = () => Date.now();

	function persist() {
		pi.appendEntry<GoalEntry>(ENTRY_TYPE, { goal: goal ?? null });
	}

	function show(ctx: ExtensionContext) {
		ctx.ui.setStatus("verified-goal", goal && goal.status !== "complete" ? statusLine(goal, now()) : undefined);
	}

	// Inside Herdr, a goal that stops for a human marks the pane blocked through the official Herdr pi
	// integration's "herdr:blocked" event, so Herdr notifies the user and `herdr agent wait` returns.
	// The integration counts active/inactive events, so emit only on edges.
	const inHerdr = process.env.HERDR_ENV === "1";
	let herdrBlocked = false;
	function signalHerdr(needsHuman: boolean) {
		if (!inHerdr || needsHuman === herdrBlocked) return;
		herdrBlocked = needsHuman;
		pi.events.emit("herdr:blocked", needsHuman ? { active: true, label: `goal ${goal?.status}: ${goal?.reason ?? ""}`.slice(0, 120) } : { active: false });
	}

	/** `byUser`: the user caused this stop (pause, Esc, reopen), so it needs no attention signal. */
	function setStatus(status: GoalStatus, reason: string | undefined, ctx?: ExtensionContext, byUser = false) {
		if (!goal) return;
		goal = transition(goal, status, reason, now());
		persist();
		signalHerdr(!byUser && (status === "blocked" || status === "limited" || status === "paused"));
		if (ctx) {
			show(ctx);
			if (status !== "active") ctx.ui.notify(`Goal ${status}${reason ? `: ${reason}` : ""}`, status === "complete" ? "info" : "warning");
		}
	}

	/** History changed underneath us (startup, resume, fork, tree navigation): rebuild from this branch. */
	function restore(ctx: ExtensionContext, why: string) {
		goal = latestGoal(ctx.sessionManager.getBranch());
		previousFindings = undefined;
		// Never auto-run a restored goal: the user may not expect autonomous work on reopen.
		if (goal?.status === "active") setStatus("paused", `${why}; /goal resume to continue`, ctx, true);
		show(ctx);
	}

	pi.on("session_start", async (event, ctx) => restore(ctx, `session ${event.reason}`));
	pi.on("session_tree", async (_event, ctx) => restore(ctx, "session tree navigation"));

	pi.on("agent_start", async () => {
		lastOutcome = "completed";
		lastError = undefined;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (!goal || msg.role !== "assistant" || (goal.status !== "active" && goal.status !== "limited")) return;
		goal = { ...goal, tokens: goal.tokens + billableTokens(msg.usage) };
		if (msg.stopReason === "error") lastError = msg.errorMessage;
	});

	pi.on("turn_end", async (event, ctx) => {
		lastOutcome = event.outcome;
		if (goal?.status !== "active" || event.outcome !== "completed") return;
		show(ctx);
		// Budgets can run out inside one long run; stop tool use there instead of waiting for settle.
		const reason = exhaustedBudget(goal, now(), false);
		if (!reason) return;
		setStatus("limited", reason, ctx);
		goal = { ...goal, wrappedUp: true };
		persist();
		return { entries: [{ type: "custom_message", customType: MESSAGE_TYPE, content: wrapUpPrompt(goal, reason, now()), display: false }] };
	});

	pi.on("tool_call", async (event) => {
		if (goal?.status === "limited" && !GOAL_TOOLS.has(event.toolName)) {
			return { block: true, reason: "The goal budget is exhausted. Do not use tools; summarize progress and stop." };
		}
	});

	// The only place automatic work is scheduled. Pi calls this once retries, compaction and queued
	// input are done, and runs exactly one more request if we return continue: true.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!goal || event.outcome !== "completed" || event.context.pendingMessages.length > 0) return;
		if (goal.status === "limited" && !goal.wrappedUp) {
			goal = { ...goal, wrappedUp: true };
			persist();
			return { entries: [{ type: "custom_message", customType: MESSAGE_TYPE, content: wrapUpPrompt(goal, goal.reason ?? "budget reached", now()), display: false }], continue: true };
		}
		if (goal.status !== "active") return;

		const progress = observeProgress(goal, await snapshotTree(ctx.cwd));
		goal = progress.goal;
		const budget = exhaustedBudget(goal, now());
		if (budget) {
			setStatus("limited", budget, ctx);
			goal = { ...goal, wrappedUp: true };
			persist();
			return { entries: [{ type: "custom_message", customType: MESSAGE_TYPE, content: wrapUpPrompt(goal, budget, now()), display: false }], continue: true };
		}
		if (progress.stalled) {
			setStatus("paused", `no workspace changes in ${goal.idleRuns} consecutive runs`, ctx);
			return;
		}
		goal = { ...goal, continuations: goal.continuations + 1 };
		persist();
		show(ctx);
		return { entries: [{ type: "custom_message", customType: MESSAGE_TYPE, content: continuationPrompt(goal, now()), display: false }], continue: true };
	});

	// A goal still active once Pi has settled was stopped by something other than our own limits.
	pi.on("agent_settled", async (_event, ctx) => {
		if (goal?.status !== "active") return;
		if (lastOutcome === "error") setStatus("blocked", classifyError(lastError), ctx);
		else if (lastOutcome === "aborted") setStatus("paused", "interrupted", ctx, true);
		else setStatus("paused", "agent stopped", ctx);
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Goal complete",
		description:
			"Claim that the active goal is fully achieved. The harness may run a verify command and an independent auditor before accepting; a rejection returns findings and the goal stays active.",
		parameters: Type.Object({
			goal_id: Type.String({ description: "The active goal id." }),
			summary: Type.String({ description: "Each requirement of the objective mapped to concrete evidence: files, commands run, results." }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const claimed = goal;
			if (!claimed || claimed.id !== params.goal_id || (claimed.status !== "active" && claimed.status !== "limited")) {
				throw new Error(`No active goal with id "${params.goal_id}".`);
			}
			const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
			const stillCurrent = () => goal?.id === claimed.id && (goal.status === "active" || goal.status === "limited");
			const reply = (text: string, terminate = false) => ({ content: [{ type: "text" as const, text }], details: undefined, terminate });

			let verify: { command: string; exitCode: number; output: string } | undefined;
			if (claimed.verify) {
				progress(`Running verify: ${claimed.verify}`);
				const r = await runVerify(ctx.cwd, claimed.verify, signal);
				if (signal?.aborted) throw new Error("Verification cancelled.");
				verify = { command: claimed.verify, exitCode: r.exitCode, output: r.output };
				if (r.exitCode !== 0) {
					return reply(`Not accepted: \`${claimed.verify}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}. The goal stays active.\n\nOutput (tail):\n${r.output.slice(-6000)}`);
				}
			}

			if (claimed.audit) {
				progress("Independent auditor reviewing the workspace…");
				const current = await snapshotTree(ctx.cwd);
				const diff = claimed.baseline && current ? await treeDiff(ctx.cwd, claimed.baseline, current) : "(workspace is not a git repository; inspect files directly)";
				const model = claimed.auditModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
				const input = { objective: claimed.objective, summary: params.summary, verify, diff, previousFindings };
				let audit = await deps.runAudit(input, { cwd: ctx.cwd, model, signal });
				// One retry for a malformed answer; a second miss is an auditor fault, not a rejection.
				if (audit.verdict === "missing" && !signal?.aborted) {
					const retry = await deps.runAudit(input, { cwd: ctx.cwd, model, signal });
					audit = { ...retry, tokens: audit.tokens + retry.tokens };
				}
				if (goal?.id === claimed.id) goal = { ...goal, tokens: goal.tokens + audit.tokens };
				if (signal?.aborted) throw new Error("Audit cancelled.");
				if (!stillCurrent()) return reply("The goal changed while the audit ran; result discarded.", true);

				if (audit.verdict === "error" || audit.verdict === "missing") {
					setStatus("paused", `auditor unavailable: ${audit.verdict === "missing" ? "no verdict line" : audit.report.slice(0, 200)}`, ctx);
					return reply(`The auditor could not run, so completion was not accepted and the goal is paused for the user.\n\n${audit.report.slice(-4000)}`, true);
				}
				if (audit.verdict === "rejected") {
					previousFindings = audit.report;
					goal = { ...goal!, rejections: goal!.rejections + 1 };
					if (goal.rejections >= goal.limits.rejections) {
						setStatus("blocked", `auditor rejected completion ${goal.rejections} times; needs human review`, ctx);
						return reply(`Auditor rejected completion again. The goal is now blocked for human review.\n\n${audit.report}`, true);
					}
					persist();
					return reply(`Auditor rejected completion (${goal.rejections}/${goal.limits.rejections}). Address every finding, then call goal_complete again.\n\n${audit.report}`);
				}
				previousFindings = undefined;
				setStatus("complete", undefined, ctx);
				return reply(`Goal complete. Auditor approved.\n\n${audit.report}`, true);
			}

			if (!stillCurrent()) return reply("The goal changed during verification; result discarded.", true);
			setStatus("complete", verify ? "verify command passed" : undefined, ctx);
			return reply(verify ? "Goal complete. Verify command passed." : "Goal complete.", true);
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal blocked",
		description: "Stop the active goal at a true impasse that needs user input or an external change. Not for work that is merely hard or slow.",
		parameters: Type.Object({
			goal_id: Type.String({ description: "The active goal id." }),
			reason: Type.String({ description: "The blocker, the evidence for it, and what the user must do." }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!goal || goal.id !== params.goal_id || goal.status !== "active") throw new Error(`No active goal with id "${params.goal_id}".`);
			setStatus("blocked", params.reason.slice(0, 500), ctx);
			return { content: [{ type: "text", text: "Goal marked blocked. Explain the blocker to the user and stop." }], details: undefined, terminate: true };
		},
	});

	function start(ctx: ExtensionContext, prompt: string) {
		pi.sendMessage({ customType: MESSAGE_TYPE, content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
		show(ctx);
	}

	pi.registerCommand("goal", {
		description: "Run an objective autonomously until it is verified complete",
		getArgumentCompletions: (prefix) =>
			["status", "pause", "resume", "clear", "--tokens", "--time", "--turns", "--idle", "--verify", "--no-audit", "--audit-model"]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "" || sub === "status") {
				if (!goal) return ctx.ui.notify(`No goal.\n${USAGE}`, "info");
				const lines = [statusLine(goal, now()), goal.reason ? `reason: ${goal.reason}` : "", goal.verify ? `verify: ${goal.verify}` : "", `objective: ${goal.objective}`];
				return ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
			}
			if (sub === "pause") {
				if (goal?.status !== "active" && goal?.status !== "limited") return ctx.ui.notify("No running goal.", "warning");
				setStatus("paused", "paused by user", ctx, true);
				return;
			}
			if (sub === "resume") {
				if (!goal || goal.status === "active" || goal.status === "complete") return ctx.ui.notify("No paused goal to resume.", "warning");
				goal = resume(goal, now());
				previousFindings = undefined;
				persist();
				signalHerdr(false);
				return start(ctx, continuationPrompt(goal, now()));
			}
			if (sub === "clear") {
				if (!goal) return ctx.ui.notify("No goal.", "info");
				if (ctx.hasUI && goal.status === "active" && !(await ctx.ui.confirm("Clear goal?", goal.objective.slice(0, 200)))) return;
				goal = undefined;
				persist();
				signalHerdr(false);
				show(ctx);
				return ctx.ui.notify("Goal cleared.", "info");
			}

			let opts: ReturnType<typeof parseGoalArgs>;
			try {
				opts = parseGoalArgs(args);
			} catch (err) {
				return ctx.ui.notify(`${(err as Error).message}\n${USAGE}`, "error");
			}
			if (goal && goal.status !== "complete") {
				if (!ctx.hasUI || !(await ctx.ui.confirm("Replace the current goal?", goal.objective.slice(0, 200)))) {
					return ctx.ui.notify("Kept the current goal. Use /goal clear first.", "warning");
				}
			}
			goal = createGoal(opts, randomUUID().slice(0, 8), now(), await snapshotTree(ctx.cwd));
			previousFindings = undefined;
			persist();
			signalHerdr(false);
			if (opts.audit && !goal.baseline) ctx.ui.notify("Not a git repository: the auditor will get no diff and must inspect files directly.", "warning");
			start(ctx, kickoffPrompt(goal, now()));
		},
	});
}
