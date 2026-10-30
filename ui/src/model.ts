import { formatDate as formatDisplayDate } from "@ryu/ui/lib/timezone.ts";
import {
	type LegacyProject,
	type LegacyTask,
	legacyStateSchema,
	type ProjectsStateInput,
	taskStatusSchema,
} from "./schemas.ts";
import type {
	Project,
	ProjectsState,
	ProjectTask,
	TaskStatus,
} from "./types.ts";

const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "done"];

function task(value: LegacyTask, index: number): ProjectTask | null {
	if (!value) {
		return null;
	}
	const title = value.title.trim();
	if (!title) {
		return null;
	}
	return {
		dueDate: value.dueDate,
		id: (value.id ?? `task-${index}`).trim() || `task-${index}`,
		owner: value.owner.trim() || "Unassigned",
		status: value.status,
		title,
	};
}

function project(value: LegacyProject, index: number): Project | null {
	if (!value) {
		return null;
	}
	const name = value.name.trim();
	if (!name) {
		return null;
	}
	const rawTasks = value.tasks;
	return {
		client: value.client.trim() || "Internal",
		coordinatorAgent: value.coordinatorAgent.trim() || null,
		coordinatorConversationId: value.coordinatorConversationId.trim() || null,
		createdAt: value.createdAt,
		cwd: value.cwd.trim() || null,
		description: value.description.trim(),
		dueDate: value.dueDate,
		executionMode: value.executionMode,
		id: (value.id ?? `project-${index}`).trim() || `project-${index}`,
		name,
		owner: value.owner.trim() || "Unassigned",
		status: value.status,
		tasks: rawTasks
			.map((item, taskIndex) => task(item, taskIndex))
			.filter((item): item is ProjectTask => item !== null)
			.slice(0, 200),
		updatedAt: value.updatedAt,
	};
}

export function emptyState(): ProjectsState {
	return { projects: [], schemaVersion: 1 };
}

export function normalizeState(value: ProjectsStateInput): ProjectsState {
	const rawProjects = legacyStateSchema.parse(value).projects;
	return {
		projects: rawProjects
			.map((item, index) => project(item, index))
			.filter((item): item is Project => item !== null)
			.slice(0, 100),
		schemaVersion: 1,
	};
}

function demoTask(
	id: string,
	title: string,
	owner: string,
	status: TaskStatus,
	dueDate: string
): ProjectTask {
	return { dueDate, id, owner, status, title };
}

export function demoState(): ProjectsState {
	return normalizeState({
		projects: [
			{
				client: "Northstar Labs",
				description:
					"Ship the first workflow that turns a reviewed brief into a handoff.",
				dueDate: "2026-09-12",
				id: "demo-operator-workflow",
				name: "Operator workflow beta",
				owner: "Jiawei",
				status: "active",
				tasks: [
					demoTask(
						"task-brief",
						"Confirm the handoff brief",
						"Jiawei",
						"done",
						"2026-08-29"
					),
					demoTask(
						"task-review",
						"Review the first run with the team",
						"Maya",
						"doing",
						"2026-09-03"
					),
					demoTask(
						"task-notes",
						"Capture the decisions in the project notes",
						"Unassigned",
						"todo",
						"2026-09-08"
					),
				],
			},
			{
				client: "Relay Systems",
				description:
					"Prepare the onboarding work for the next customer conversation.",
				dueDate: "2026-09-19",
				id: "demo-relay-onboarding",
				name: "Relay onboarding",
				owner: "Sam",
				status: "planned",
				tasks: [
					demoTask(
						"task-access",
						"Confirm workspace access",
						"Sam",
						"todo",
						"2026-09-05"
					),
					demoTask(
						"task-walkthrough",
						"Book the workflow walkthrough",
						"Sam",
						"todo",
						"2026-09-12"
					),
				],
			},
			{
				client: "Internal",
				description:
					"Keep the release checklist current for the shared app fleet.",
				dueDate: "2026-08-22",
				id: "demo-release-checklist",
				name: "Release checklist",
				owner: "Ryu",
				status: "done",
				tasks: [
					demoTask(
						"task-docs",
						"Update public docs",
						"Ryu",
						"done",
						"2026-08-20"
					),
					demoTask(
						"task-proof",
						"Capture the product proof",
						"Ryu",
						"done",
						"2026-08-22"
					),
				],
			},
		],
	});
}

export interface NewProjectInput {
	client: string;
	description: string;
	dueDate: string;
	goal?: string;
	name: string;
	owner: string;
}

export function createProject(input: NewProjectInput): Project {
	const now = Date.now();
	return {
		client: input.client.trim() || "Internal",
		coordinatorAgent: null,
		coordinatorConversationId: null,
		createdAt: now,
		cwd: null,
		description: input.description.trim(),
		dueDate: input.dueDate,
		executionMode: "auto",
		goal: input.goal?.trim() ?? "",
		id: `project-${now}`,
		name: input.name.trim(),
		owner: input.owner.trim() || "Unassigned",
		status: "planned",
		tasks: [],
		updatedAt: now,
	};
}

/** Longest project instructions Core accepts; they ride in every member
 * thread's system prompt, so they are capped like goals. */
export const MAX_INSTRUCTIONS_CHARS = 4000;

/**
 * The instructions a save would store, or null when the draft leaves them as
 * they are. A null result means no save and no prompt-cache confirmation:
 * Core compares trimmed text too, so whitespace-only edits cost nothing.
 */
export function instructionsChange(
	project: Pick<Project, "instructions">,
	draft: string
): string | null {
	const next = draft.trim();
	return next === (project.instructions ?? "").trim() ? null : next;
}

export function createTask(title: string): ProjectTask {
	return {
		dueDate: "",
		id: `task-${Date.now()}`,
		owner: "Unassigned",
		status: "todo",
		title: title.trim(),
	};
}

export function patchProject(
	state: ProjectsState,
	projectId: string,
	patch: Partial<Project>
): ProjectsState {
	return {
		...state,
		projects: state.projects.map((item) =>
			item.id === projectId ? { ...item, ...patch } : item
		),
	};
}

export function addTask(
	state: ProjectsState,
	projectId: string,
	newTask: ProjectTask
): ProjectsState {
	return {
		...state,
		projects: state.projects.map((item) =>
			item.id === projectId
				? { ...item, tasks: [...item.tasks, newTask] }
				: item
		),
	};
}

export function updateTask(
	state: ProjectsState,
	projectId: string,
	taskId: string,
	patch: Partial<ProjectTask>
): ProjectsState {
	return {
		...state,
		projects: state.projects.map((item) =>
			item.id === projectId
				? {
						...item,
						tasks: item.tasks.map((itemTask) =>
							itemTask.id === taskId ? { ...itemTask, ...patch } : itemTask
						),
					}
				: item
		),
	};
}

export function projectProgress(project: Project): number {
	if (project.tasks.length === 0) {
		return project.status === "done" ? 100 : 0;
	}
	return Math.round(
		(project.tasks.filter((item) => item.status === "done").length /
			project.tasks.length) *
			100
	);
}

interface ProjectStatsResult {
	active: number;
	openTasks: number;
	total: number;
}

export function projectStats(projects: Project[]): ProjectStatsResult {
	return {
		active: projects.filter((item) => item.status === "active").length,
		openTasks: projects.reduce(
			(total, item) =>
				total +
				item.tasks.filter((taskItem) => taskItem.status !== "done").length,
			0
		),
		total: projects.length,
	};
}

export function nextTaskStatus(status: string): TaskStatus {
	const knownStatus = taskStatusSchema.safeParse(status);
	const index = knownStatus.success
		? TASK_STATUSES.indexOf(knownStatus.data)
		: -1;
	return TASK_STATUSES[(index + 1) % TASK_STATUSES.length] ?? "todo";
}

export function statusLabel(status: string): string {
	return status === "todo"
		? "To do"
		: status === "doing"
			? "In progress"
			: status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatDueDate(value: string): string {
	if (!value) {
		return "No due date";
	}
	const date = new Date(`${value}T00:00:00`);
	return Number.isNaN(date.getTime())
		? "No due date"
		: formatDisplayDate(value, {
				day: "numeric",
				month: "short",
				year: "numeric",
			});
}
