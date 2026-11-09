import type { CSSProperties } from "react";
import type { ExecutionMode, Project, ProjectStatus } from "./types.ts";

export type Filter = "all" | ProjectStatus;

export const FILTERS: Array<{ id: Filter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "active", label: "Active" },
	{ id: "planned", label: "Planned" },
	{ id: "blocked", label: "Blocked" },
	{ id: "done", label: "Done" },
];

export interface NewProjectForm {
	client: string;
	cwd: string;
	description: string;
	dueDate: string;
	executionMode: ExecutionMode;
	goal: string;
	name: string;
	owner: string;
}

export const EMPTY_FORM: NewProjectForm = {
	client: "",
	cwd: "",
	description: "",
	dueDate: "",
	executionMode: "auto",
	goal: "",
	name: "",
	owner: "",
};

export type BriefChoice = "inherit" | "off" | "on";

export function briefChoice(value: boolean | null | undefined): BriefChoice {
	if (value === true) {
		return "on";
	}
	return value === false ? "off" : "inherit";
}

export function briefValue(choice: BriefChoice): boolean | null {
	if (choice === "on") {
		return true;
	}
	return choice === "off" ? false : null;
}

/** A save that edits the system prompt, held until the user confirms the
 * prompt-cache reset it causes. */
export interface PendingPromptEdit {
	apply: () => Promise<void>;
	description: string;
	title: string;
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Something went wrong. Try again.";
}

export function projectStatusVariant(
	status: Project["status"]
): "default" | "secondary" | "destructive" | "outline" {
	if (status === "active") {
		return "default";
	}
	if (status === "done") {
		return "secondary";
	}
	if (status === "blocked") {
		return "destructive";
	}
	return "outline";
}

export function taskStatusVariant(
	status: Project["tasks"][number]["status"]
): "default" | "secondary" | "outline" {
	return status === "done"
		? "secondary"
		: status === "doing"
			? "default"
			: "outline";
}

export function executionLabel(mode: Project["executionMode"]): string {
	return mode === "cloud" ? "Cloud" : mode === "local" ? "Local" : "Auto";
}

export interface ProjectProgressStyle extends CSSProperties {
	"--project-progress": string;
}
