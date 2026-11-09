import { expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { projectSubtitle } from "./App-project-subtitle.ts";

const GERMAN: Record<string, string> = {
	Internal: "Intern",
	"No due date": "Kein Fälligkeitsdatum",
};

const german = (source: string, values?: MessageValuesInput) =>
	formatMessage(GERMAN[source] ?? source, values, "de");

test("a project without a client reads as Internal in the UI language", () => {
	expect(projectSubtitle(german, { client: "", dueDate: "" })).toBe(
		"Intern · Kein Fälligkeitsdatum"
	);
	expect(projectSubtitle(german, { client: "Acme", dueDate: "" })).toBe(
		"Acme · Kein Fälligkeitsdatum"
	);
	const dated = projectSubtitle(german, { client: "", dueDate: "2026-11-03" });
	expect(dated).toStartWith("Intern · ");
	expect(dated).not.toContain("Internal");
	expect(dated).toContain("2026");
});
