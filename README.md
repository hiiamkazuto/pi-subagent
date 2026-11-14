# pi-subagent

Background subagents for [pi](https://pi.dev). Each subagent runs in a separate `pi` process with its own context window. Started from pi v1.5.2's `examples/extensions/subagent`; now maintained independently.

## Install

```bash
pi install ~/Workspace/pi-subagent
```

## Tools

| Tool | Params | |
|---|---|---|
| `subagent` | `agent`, `task`, `cwd?`, `resume?` | Starts a child in the background and returns its id right away. Call it several times to run children in parallel. There is no concurrency limit. |
| `subagent_status` | — | Lists the runs in this session. |
| `subagent_result` | `id` | Returns the output (truncated at 50KB / 2000 lines). Adds the run's usage to the parent's totals, once per run. |
| `subagent_cancel` | `id` | Sends SIGTERM, then SIGKILL after 5s. |

When a run finishes, a one-line notification is sent as a `followUp`, which wakes the parent agent.

## Agents

- Built-in: `scout`, `worker` (`agents/`).
- `~/.pi/agent/agents/*.md` adds agents. A file with the same name as a built-in replaces it.
- Frontmatter: `name`, `description`, `tools?`, `model?` (`provider/id` or `id`), `thinking?`. If `model` or `thinking` is omitted, the parent's value is used. An unknown model falls back to the parent's model with a warning.

## Sessions

- Child sessions are stored in `~/.pi/agent/subagent-sessions/`, so they don't show up in `/resume`. A run's id is its session id.
- `resume: <id>` continues a session with the same agent and cwd.
- Results can still be read after the parent restarts, because they are re-read from disk.
- Files not modified for 7 days are deleted on `session_start`.
- Running children are killed on `session_shutdown`.

## Depth

`PI_SUBAGENT_DEPTH` sets how many more levels of subagents may be spawned. Unset means 1. Each child gets the value minus 1. The tools are only registered when the value is at least 1.

## Development

```bash
npm test          # vitest; uses test/fixtures/fake-pi.mjs instead of real pi
npm run typecheck
```
