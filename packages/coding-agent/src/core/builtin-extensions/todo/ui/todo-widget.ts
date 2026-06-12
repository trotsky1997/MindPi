/**
 * TodoWidget — read-only widget showing the current todo list.
 * Ported from pi-manage-todo-list (src/ui/todo-widget.ts).
 *
 * Displayed above the editor using ctx.ui.setWidget().
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../extensions/types.ts";
import type { TodoStateManager } from "../state-manager.ts";

const WIDGET_ID = "todo-list";

/** Status icons for each todo state. */
export const STATUS_ICONS: Record<string, string> = {
	completed: "✓",
	"in-progress": "◉ ",
	"not-started": "○",
};

/** Update (or clear) the todo widget. Call after every state change. */
export function updateWidget(state: TodoStateManager, ctx: ExtensionContext): void {
	const todos = state.read();

	if (todos.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}

	const stats = state.getStats();

	ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
		const lines: string[] = [];

		const header =
			theme.fg("accent", " Todo List ") + theme.fg("muted", `— ${stats.completed}/${stats.total} completed`);
		lines.push(header);

		for (const todo of todos) {
			const icon = STATUS_ICONS[todo.status] ?? "⏳";
			const id = theme.fg("accent", `${todo.id}.`);

			let title: string;
			if (todo.status === "completed") {
				title = theme.fg("dim", theme.strikethrough(todo.title));
			} else if (todo.status === "in-progress") {
				title = theme.fg("warning", todo.title);
			} else {
				title = todo.title;
			}

			lines.push(`  ${icon} ${id} ${title}`);
		}

		return {
			render: (width: number) => lines.map((l) => truncateToWidth(l, width)),
			invalidate: () => {},
		};
	});
}

/** Clear the widget. */
export function clearWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(WIDGET_ID, undefined);
}
