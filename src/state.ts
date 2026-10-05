// Pure goal state: types, argument parsing, limits, persistence snapshot. No pi imports, so it is unit-testable.

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";

export interface GoalLimits {
	/** Hard cap on automatic continuations. */
	continuations: number;
	/** Pause after this many consecutive runs that leave the workspace unchanged. 0 disables. */
	idleRuns: number;
	/** Block after this many auditor rejections. */
	rejections: number;
	tokens?: number;
	ms?: number;
}

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	reason?: string;
	limits: GoalLimits;
	/** Shell command the harness runs before accepting completion. Set only by the user. */
	verify?: string;
	audit: boolean;
	/** "provider/model" for the auditor; defaults to the executor's model at audit time. */
	auditModel?: string;
	/** Git commit snapshotting the workspace when the goal started. */
	baseline?: string;
	/** Billable tokens: input + output + cache writes. Cache reads are excluded. */
	tokens: number;
	activeMs: number;
	activeSince?: number;
	continuations: number;
	idleRuns: number;
	lastFingerprint?: string;
	rejections: number;
	/** The budget wrap-up message has been delivered. */
	wrappedUp: boolean;
	createdAt: number;
}

export const ENTRY_TYPE = "verified-goal";

export const DEFAULT_LIMITS: GoalLimits = { continuations: 30, idleRuns: 5, rejections: 3 };

export interface GoalOptions {
	objective: string;
	limits: GoalLimits;
	verify?: string;
	audit: boolean;
	auditModel?: string;
}

/** Split a command line into words, honoring single and double quotes. */
export function tokenize(input: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: string | undefined;
	let inWord = false;
	for (const ch of input) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (quote) throw new Error(`Unterminated ${quote} quote`);
	if (inWord) words.push(word);
	return words;
}

export function parseTokens(value: string): number {
	const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value.trim());
	if (!m) throw new Error(`Invalid token budget "${value}" (use e.g. 200k or 1.5m)`);
	const scale = { "": 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as "" | "k" | "m"];
	return Math.round(Number(m[1]) * scale);
}

export function parseDuration(value: string): number {
	const parts = [...value.trim().matchAll(/(\d+(?:\.\d+)?)([hms])/gi)];
	if (parts.length === 0 || parts.map((p) => p[0]).join("") !== value.trim()) {
		throw new Error(`Invalid duration "${value}" (use e.g. 45m, 2h or 1h30m)`);
	}
	const unit = { h: 3_600_000, m: 60_000, s: 1000 };
	return parts.reduce((ms, p) => ms + Number(p[1]) * unit[p[2].toLowerCase() as "h" | "m" | "s"], 0);
}

function parseCount(flag: string, value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} needs a non-negative integer`);
	return Number(value);
}

/**
 * Parse `/goal` arguments: flags first, then the objective.
 * Leading flags are consumed until the first non-flag word; everything after is the objective verbatim.
 */
export function parseGoalArgs(args: string, defaults: GoalLimits = DEFAULT_LIMITS): GoalOptions {
	const words = tokenize(args);
	const limits: GoalLimits = { ...defaults };
	const opts: Omit<GoalOptions, "objective" | "limits"> = { audit: true };
	let i = 0;
	const next = (flag: string) => {
		const v = words[++i];
		if (v === undefined) throw new Error(`${flag} needs a value`);
		return v;
	};
	for (; i < words.length && words[i].startsWith("--"); i++) {
		const flag = words[i];
		switch (flag) {
			case "--tokens":
				limits.tokens = parseTokens(next(flag));
				break;
			case "--time":
				limits.ms = parseDuration(next(flag));
				break;
			case "--turns":
				limits.continuations = parseCount(flag, next(flag));
				break;
			case "--idle":
				limits.idleRuns = parseCount(flag, next(flag));
				break;
			case "--verify":
				opts.verify = next(flag);
				break;
			case "--audit-model":
				opts.auditModel = next(flag);
				break;
			case "--no-audit":
				opts.audit = false;
				break;
			case "--":
				i++;
				break;
			default:
				throw new Error(`Unknown flag ${flag}`);
		}
		if (flag === "--") break;
	}
	// Re-extract the objective from the raw text so its quoting and whitespace survive.
	const objective = words.length > i ? stripLeadingWords(args, i) : "";
	if (!objective) throw new Error("Missing objective");
	return { objective, limits, ...opts };
}

function stripLeadingWords(raw: string, count: number): string {
	let rest = raw.trimStart();
	for (let n = 0; n < count; n++) {
		const m = /^(?:"[^"]*"|'[^']*'|\S)+\s*/.exec(rest);
		rest = m ? rest.slice(m[0].length) : "";
	}
	return rest.trim();
}

export function createGoal(opts: GoalOptions, id: string, now: number, baseline?: string): Goal {
	return {
		id,
		objective: opts.objective,
		status: "active",
		limits: opts.limits,
		verify: opts.verify,
		audit: opts.audit,
		auditModel: opts.auditModel,
		baseline,
		tokens: 0,
		activeMs: 0,
		activeSince: now,
		continuations: 0,
		idleRuns: 0,
		rejections: 0,
		wrappedUp: false,
		createdAt: now,
	};
}

export function elapsedMs(goal: Goal, now: number): number {
	return goal.activeMs + (goal.activeSince === undefined ? 0 : now - goal.activeSince);
}

/** Move to a new status, keeping active-time accounting consistent. */
export function transition(goal: Goal, status: GoalStatus, reason: string | undefined, now: number): Goal {
	const activeMs = elapsedMs(goal, now);
	return { ...goal, status, reason, activeMs, activeSince: status === "active" ? now : undefined };
}

/** Resume a paused/blocked/limited goal with fresh run counters (budgets keep counting). */
export function resume(goal: Goal, now: number): Goal {
	return { ...transition(goal, "active", undefined, now), continuations: 0, idleRuns: 0, rejections: 0, wrappedUp: false };
}

/** Which budget, if any, the goal has exhausted. Mid-run checks pass `includeRuns: false`. */
export function exhaustedBudget(goal: Goal, now: number, includeRuns = true): string | undefined {
	if (goal.limits.tokens !== undefined && goal.tokens >= goal.limits.tokens) {
		return `token budget reached (${goal.tokens} of ${goal.limits.tokens})`;
	}
	if (goal.limits.ms !== undefined && elapsedMs(goal, now) >= goal.limits.ms) {
		return `time budget reached (${formatDuration(elapsedMs(goal, now))})`;
	}
	if (includeRuns && goal.continuations >= goal.limits.continuations) {
		return `automatic continuation cap reached (${goal.limits.continuations})`;
	}
	return undefined;
}

/**
 * Record the workspace fingerprint at the end of a run and report a stall.
 * An undefined fingerprint (no git) disables stall detection.
 */
export function observeProgress(goal: Goal, fingerprint: string | undefined): { goal: Goal; stalled: boolean } {
	if (fingerprint === undefined || goal.limits.idleRuns === 0) return { goal, stalled: false };
	const idleRuns = fingerprint === goal.lastFingerprint ? goal.idleRuns + 1 : 0;
	return { goal: { ...goal, idleRuns, lastFingerprint: fingerprint }, stalled: idleRuns >= goal.limits.idleRuns };
}

export function billableTokens(usage: { input?: number; output?: number; cacheWrite?: number } | undefined): number {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
}

const USAGE_LIMIT = /usage limit|quota|rate limit|insufficient[_ ]credit|billing|429/i;

export function classifyError(message: string | undefined): string {
	const text = (message ?? "unknown error").slice(0, 300);
	return USAGE_LIMIT.test(text) ? `provider usage limit: ${text}` : `provider error: ${text}`;
}

/** Persisted entry payload: a goal snapshot, or null after /goal clear. */
export type GoalEntry = { goal: Goal | null };

/** Latest goal snapshot on the given branch (entries in root-to-leaf order). */
export function latestGoal(entries: readonly { type: string; customType?: string; data?: unknown }[]): Goal | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === ENTRY_TYPE) {
			return (e.data as GoalEntry | undefined)?.goal ?? undefined;
		}
	}
	return undefined;
}

export function formatDuration(ms: number): string {
	const m = Math.floor(ms / 60_000);
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export function formatTokens(n: number): string {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

export function statusLine(goal: Goal, now: number): string {
	const parts = [`goal ${goal.status}`, `${goal.continuations}/${goal.limits.continuations} runs`];
	parts.push(goal.limits.tokens ? `${formatTokens(goal.tokens)}/${formatTokens(goal.limits.tokens)} tok` : `${formatTokens(goal.tokens)} tok`);
	parts.push(formatDuration(elapsedMs(goal, now)) + (goal.limits.ms ? `/${formatDuration(goal.limits.ms)}` : ""));
	if (goal.verify) parts.push("verify");
	if (goal.audit) parts.push("audit");
	return parts.join(" · ");
}
