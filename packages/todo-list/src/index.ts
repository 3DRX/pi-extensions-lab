/**
 * Todo List Extension - lets the agent plan and track multi-step work
 *
 * This extension:
 * - Registers a `todo` tool so the LLM can maintain a todo list
 * - Registers a `/todos` command for users to view (or clear) the list
 * - Shows a compact `done/total` indicator in the footer while a list exists
 *
 * The tool is always available but never forced: prompt guidance tells the
 * agent to use it only for complex, multi-step tasks and to answer simple
 * requests directly without tracking overhead.
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history. A custom `todo-list-reset` entry lets
 * the user clear the list via `/todos clear` without breaking branching.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TUnsafe } from "typebox";

const TOOL_NAME = "todo";
const STATUS_KEY = "todo-list";
const RESET_ENTRY = "todo-list-reset";

type TodoStatus = "pending" | "in_progress" | "completed";
type TodoAction = "list" | "add" | "update" | "remove" | "clear";

interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: TodoAction;
	todos: TodoItem[];
	nextId: number;
	error?: string;
}

/**
 * Google-compatible string enum (same shape as StringEnum from
 * `@earendil-works/pi-ai`, inlined to avoid the extra dependency).
 */
function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string }): TUnsafe<T[number]> {
	return Type.Unsafe({
		type: "string",
		enum: values,
		...(options?.description ? { description: options.description } : {}),
	});
}

const TodoStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description: "Task status. Setting a task to in_progress moves every other task back to pending.",
});

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "remove", "clear"] as const, {
		description:
			"list: show all tasks. add: create a task (requires text). update: change a task (requires id, plus text and/or status). remove: delete a task (requires id). clear: delete all tasks.",
	}),
	id: Type.Optional(Type.Number({ description: "Task id. Required for update and remove." })),
	text: Type.Optional(Type.String({ description: "Task text. Required for add; optional for update." })),
	status: Type.Optional(TodoStatusSchema),
});

function statusMark(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[>]";
		default:
			return "[ ]";
	}
}

function formatTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "Todo list is empty.";
	const lines = todos.map((t) => `${statusMark(t.status)} #${t.id} ${t.text}`);
	const done = todos.filter((t) => t.status === "completed").length;
	return [`${done}/${todos.length} completed:`, ...lines].join("\n");
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private readonly todos: TodoItem[];
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos. The agent creates them for complex tasks.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const icon =
					todo.status === "completed"
						? th.fg("success", "✓")
						: todo.status === "in_progress"
							? th.fg("accent", "▶")
							: th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text =
					todo.status === "completed"
						? th.fg("dim", todo.text)
						: todo.status === "in_progress"
							? th.fg("text", todo.text)
							: th.fg("muted", todo.text);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function todoListExtension(pi: ExtensionAPI): void {
	// In-memory state (reconstructed from session entries on load/branch)
	let todos: TodoItem[] = [];
	let nextId = 1;

	function snapshot(action: TodoAction, error?: string): TodoDetails {
		return { action, todos: todos.map((t) => ({ ...t })), nextId, error };
	}

	function errorResult(action: TodoAction, message: string) {
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: snapshot(action, message),
		};
	}

	function demoteOtherInProgress(exceptId: number): void {
		for (const todo of todos) {
			if (todo.id !== exceptId && todo.status === "in_progress") {
				todo.status = "pending";
			}
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const done = todos.filter((t) => t.status === "completed").length;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `☑ ${done}/${todos.length}`));
	}

	/**
	 * Reconstruct state from session entries. Tool result snapshots are
	 * applied in order; a `todo-list-reset` custom entry (from /todos clear)
	 * resets the list at that point in history.
	 */
	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
				const details = msg.details as TodoDetails | undefined;
				if (details && Array.isArray(details.todos)) {
					todos = details.todos;
					nextId = details.nextId;
				}
			} else if (entry.type === "custom" && entry.customType === RESET_ENTRY) {
				todos = [];
				nextId = 1;
			}
		}
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description:
			"Track multi-step work in a shared todo list so progress is visible. " +
			"Use it only for complex tasks (roughly 3+ distinct steps, multiple files, or work spanning many tool calls); " +
			"do NOT use it for simple, single-step, or conversational requests. " +
			"Actions: list, add (text), update (id, text and/or status), remove (id), clear. " +
			"Keep exactly one task in_progress at a time, and mark tasks completed as soon as they are done.",
		promptSnippet: "Plan and track progress on complex multi-step tasks in a todo list",
		promptGuidelines: [
			"Use the todo tool to plan and track progress only for complex, multi-step tasks; for short or simple requests, answer directly without the todo tool.",
			"When the todo tool is in use, keep exactly one task in_progress and mark each task completed with the todo tool as soon as it is finished.",
			"When a tracked task becomes irrelevant, remove it with the todo tool instead of leaving a stale list.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatTodos(todos) }],
						details: snapshot("list"),
					};

				case "add": {
					if (!params.text?.trim()) {
						return errorResult("add", "text is required for add");
					}
					const status: TodoStatus = params.status ?? "pending";
					const todo: TodoItem = { id: nextId++, text: params.text.trim(), status };
					todos.push(todo);
					if (status === "in_progress") demoteOtherInProgress(todo.id);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Added todo #${todo.id}: ${todo.text}` }],
						details: snapshot("add"),
					};
				}

				case "update": {
					if (params.id === undefined) {
						return errorResult("update", "id is required for update");
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return errorResult("update", `todo #${params.id} not found`);
					}
					if (params.text?.trim()) {
						todo.text = params.text.trim();
					}
					if (params.status) {
						todo.status = params.status;
						if (params.status === "in_progress") demoteOtherInProgress(todo.id);
					}
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Updated todo #${todo.id}: ${statusMark(todo.status)} ${todo.text}` }],
						details: snapshot("update"),
					};
				}

				case "remove": {
					if (params.id === undefined) {
						return errorResult("remove", "id is required for remove");
					}
					const index = todos.findIndex((t) => t.id === params.id);
					if (index === -1) {
						return errorResult("remove", `todo #${params.id} not found`);
					}
					const [removed] = todos.splice(index, 1);
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Removed todo #${removed.id}: ${removed.text}` }],
						details: snapshot("remove"),
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `Cleared ${count} todo${count === 1 ? "" : "s"}` }],
						details: snapshot("clear"),
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.action ?? "");
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("dim", `→ ${args.status}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const list = details.todos;
			if (list.length === 0) {
				return new Text(theme.fg("dim", "Todo list is empty"), 0, 0);
			}

			const done = list.filter((t) => t.status === "completed").length;
			let text = theme.fg("muted", `${done}/${list.length} completed`);
			const display = expanded ? list : list.slice(0, 7);
			for (const todo of display) {
				const icon =
					todo.status === "completed"
						? theme.fg("success", "✓")
						: todo.status === "in_progress"
							? theme.fg("accent", "▶")
							: theme.fg("dim", "○");
				const line =
					todo.status === "completed"
						? theme.fg("dim", todo.text)
						: todo.status === "in_progress"
							? theme.fg("text", todo.text)
							: theme.fg("muted", todo.text);
				text += `\n${icon} ${line}`;
			}
			if (!expanded && list.length > 7) {
				text += `\n${theme.fg("dim", `... ${list.length - 7} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the todo list; use /todos clear to reset it",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "clear") {
				todos = [];
				nextId = 1;
				// Persist the reset so session branching reconstructs correctly
				pi.appendEntry(RESET_ENTRY, {});
				updateStatus(ctx);
				ctx.ui.notify("Todo list cleared.", "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
