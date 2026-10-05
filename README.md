# pi-verified-goal

Codex-style `/goal` for [pi](https://pi.dev): the agent keeps working on an objective across turns until it is done. Unlike other goal extensions, **the agent cannot declare itself done.** Completion must pass gates the harness runs and the agent cannot edit, skip or switch off.

## Usage

```
/goal [flags] <objective>
/goal status | pause | resume | clear
```

| Flag | Default | Meaning |
|---|---|---|
| `--verify "<cmd>"` | none | Shell command that must exit 0 before completion is accepted |
| `--no-audit` | audit on | Skip the independent auditor |
| `--audit-model provider/id` | executor's model | Model for the auditor (a different model is a stronger check) |
| `--tokens 500k` | none | Token budget (input + output + cache writes; cache reads excluded) |
| `--time 2h` | none | Active-time budget |
| `--turns N` | 30 | Cap on automatic continuations |
| `--idle N` | 5 | Pause after N consecutive runs that leave the workspace unchanged (0 disables) |

Example: `/goal --verify "npm test" --tokens 2m Migrate the date utils from moment to date-fns`

## How completion works

When the agent calls `goal_complete`:

1. **Verify:** the harness runs `--verify` in `/bin/sh`. A non-zero exit returns the output tail to the agent, and the goal stays active.
2. **Audit:** a separate `pi` process is started with no session history, skills, prompt templates or context files, and only `read, grep, find, ls`. It receives:
   - the objective as you wrote it;
   - the agent's summary, marked untrusted;
   - the verify output;
   - a diff the harness computes between the workspace when the goal started and now, including new untracked files.

   It must end with `VERDICT: APPROVED` on the last line. A rejection anywhere fails safe.
3. **Outcome:**
   - A rejection returns the findings to the agent, and the next audit checks whether they were fixed.
   - Three rejections block the goal for human review.
   - An auditor crash, timeout or missing verdict pauses the goal. It never loops.

The objective, verify command and audit settings are set only by `/goal` and stored in the session. Tools can't change them, and no file the agent can write affects them.

## Safety

- **When it continues:** continuation runs only through pi's `agent_before_settle` boundary, after retries, compaction and queued input are done. Queued user input always runs first.
- **Interruptions:** Esc pauses the goal. Provider errors block it, with usage limits reported separately.
- **Budgets:** an exhausted budget gets one wrap-up turn with tools disabled. Token and time budgets are checked after every turn, not only at the end of a run.
- **Reopening:** resuming, forking, reloading or navigating `/tree` restores the branch's goal as paused. It never auto-runs.
- **State size:** state is a session entry written on transitions and once per continuation, not on every tool call.

## Notes

- Uninstall other `/goal` extensions first (`pi remove npm:@narumitw/pi-goal`). They register the same command and tool names.
- Outside git, the auditor gets no diff and stall detection is off.
- If the auditor's model comes from an extension provider, the auditor retries with extensions loaded. The `--tools` allowlist still keeps it read-only.

## Development

```
npm install
npm test          # unit + fake-host extension tests + real git workspace tests
npm run typecheck
```
