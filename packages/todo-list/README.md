# @3drx/pi-todo-list

A Pi extension that gives the agent a **todo list** for planning and tracking complex, multi-step work.

The extension registers a `todo` tool. For long tasks the agent can break the work into tracked steps and update them as it progresses:

```text
1/4 completed:
[ ] #1 Read existing auth flow
[>] #2 Refactor token refresh
[ ] #3 Add tests
[x] #4 Update docs
```

## Opt-in by design

The tool is always available, but never forced. Prompt guidance tells the agent to:

- use the todo tool only for complex tasks (roughly 3+ steps, multiple files, or many tool calls)
- answer short or simple requests directly, without tracking overhead
- keep exactly one task `in_progress` at a time while a list is active
- mark tasks `completed` as soon as they are done
- remove tasks that become irrelevant instead of leaving a stale list

Setting a task to `in_progress` automatically moves every other task back to `pending`, so there is always at most one active task.

## Tool actions

| Action   | Parameters             | Effect                        |
| -------- | ---------------------- | ----------------------------- |
| `list`   | —                      | Show all tasks                |
| `add`    | `text`, `status?`      | Create a task                 |
| `update` | `id`, `text?/status?`  | Change a task's text/status   |
| `remove` | `id`                   | Delete a task                 |
| `clear`  | —                      | Delete all tasks              |

Statuses: `pending`, `in_progress`, `completed`.

## Commands

```text
/todos          # view the current todo list in an overlay
/todos clear    # reset the list
```

While a list exists, a `☑ done/total` indicator is shown in the footer.

## State and branching

Todo state is stored in tool result details inside the session, not in external files. Branching (`/fork`, `/tree`) and session resume automatically restore the todo list that was current at that point in history. `/todos clear` persists a reset entry so clearing also survives branching correctly.

## Local development

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-todo-list typecheck
pi -e ./packages/todo-list/src/index.ts
```

Or load the whole monorepo Pi package:

```bash
pi -e /absolute/path/to/pi-extensions-lab
```

Then give the agent a longer task, e.g.:

```text
Refactor the config loading to support profiles, add tests, and update the README.
```

## Notes on Pi API coverage

Pi's extension API is sufficient for this feature:

1. `pi.registerTool()` exposes the `todo` tool with `promptSnippet`/`promptGuidelines` for opt-in usage guidance.
2. Tool result `details` + `ctx.sessionManager` implement branch-aware state reconstruction.
3. `ctx.ui.setStatus()` renders the footer progress indicator.
4. `pi.registerCommand()` + `ctx.ui.custom()` provide the `/todos` overlay.
5. `pi.appendEntry()` persists user-initiated resets across branches.
