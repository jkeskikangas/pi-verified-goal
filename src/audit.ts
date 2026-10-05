// Independent completion auditor: a separate pi process with no session history, skills, prompt
// templates, context files or (when the model allows) extensions, and only read-only tools.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { AUDITOR_SYSTEM_PROMPT, type AuditInput, auditPrompt, parseVerdict, type Verdict } from "./prompts.ts";
import { billableTokens } from "./state.ts";
import { run } from "./workspace.ts";

const AUDIT_TIMEOUT_MS = 20 * 60_000;
const AUDITOR_TOOLS = "read,grep,find,ls";

export interface AuditResult {
	verdict: Verdict | "error";
	report: string;
	tokens: number;
}

/** Re-invoke the running pi binary, falling back to `pi` on PATH. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
	return { command: "pi", args };
}

interface JsonMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cacheWrite?: number };
}

function textOf(message: JsonMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
}

/** Extract the auditor's final answer and token use from a pi JSON-mode event stream. */
export function parseAuditStream(stdout: string): { report: string; tokens: number; error?: string } {
	let report = "";
	let tokens = 0;
	let error: string | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: { type?: string; message?: JsonMessage };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = event.message;
		if (event.type !== "message_end" || msg?.role !== "assistant") continue;
		tokens += billableTokens(msg.usage);
		const text = textOf(msg);
		if (text.trim()) report = text;
		error = msg.stopReason === "error" || msg.stopReason === "aborted" ? msg.errorMessage || msg.stopReason : undefined;
	}
	return { report, tokens, error };
}

const MODEL_NOT_FOUND = /Model ".*" not found/;

export async function runAudit(input: AuditInput, opts: { cwd: string; model?: string; signal?: AbortSignal }): Promise<AuditResult> {
	const first = await spawnAuditor(input, opts, false);
	// A model served by an extension provider is invisible with --no-extensions. Retry with extensions
	// loaded; the --tools allowlist still applies to extension tools, so the auditor stays read-only.
	if (first.verdict === "error" && MODEL_NOT_FOUND.test(first.report) && !opts.signal?.aborted) {
		return spawnAuditor(input, opts, true);
	}
	return first;
}

async function spawnAuditor(input: AuditInput, opts: { cwd: string; model?: string; signal?: AbortSignal }, withExtensions: boolean): Promise<AuditResult> {
	const args = [
		"--mode", "json", "-p", "--no-session",
		"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
		"--tools", AUDITOR_TOOLS,
		"--system-prompt", AUDITOR_SYSTEM_PROMPT,
	];
	if (!withExtensions) args.push("--no-extensions");
	if (opts.model) args.push("--model", opts.model);
	args.push("--", auditPrompt(input));
	const inv = piInvocation(args);
	const result = await run(inv.command, inv.args, { cwd: opts.cwd, signal: opts.signal, timeoutMs: AUDIT_TIMEOUT_MS, maxOutput: 5_000_000 });
	const parsed = parseAuditStream(result.output);
	if (opts.signal?.aborted) return { verdict: "error", report: "Audit cancelled.", tokens: parsed.tokens };
	if (result.timedOut) return { verdict: "error", report: "Auditor timed out.", tokens: parsed.tokens };
	if (parsed.error || (result.exitCode !== 0 && !parsed.report)) {
		const detail = parsed.error ?? result.output.split("\n").filter((l) => !l.startsWith("{")).join("\n").trim().slice(-2000);
		return { verdict: "error", report: `Auditor failed (exit ${result.exitCode}): ${detail || "no output"}`, tokens: parsed.tokens };
	}
	return { verdict: parseVerdict(parsed.report), report: parsed.report, tokens: parsed.tokens };
}
