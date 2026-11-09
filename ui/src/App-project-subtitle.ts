import type { LiteralMessage } from "@ryu/i18n/react";
import { formatDueDate } from "./model.ts";
import type { Project } from "./types.ts";

/** What `formatDueDate` shows when a project has no (valid) due date. */
const NO_DUE_DATE = "No due date";

/**
 * A saved project's list subtitle: its client, or "Internal" when it has
 * none, then its due date. The fallback words go through `tl`, because the
 * composed line can never match a catalogued literal in the DOM.
 */
export function projectSubtitle(
	tl: LiteralMessage,
	project: Pick<Project, "client" | "dueDate">
): string {
	const due = formatDueDate(project.dueDate);
	const client = project.client || tl("Internal");
	return `${client} · ${due === NO_DUE_DATE ? tl("No due date") : due}`;
}
