import type {
	Project,
	ProjectStatus,
	ProjectsState,
	ProjectTask,
	TaskStatus,
} from "./types.ts";

const PROJECT_STATUSES: ProjectStatus[] = [
	"planned",
	"active",
	"blocked",
	"done",
];
const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "done"];

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function projectStatus(value: unknown): ProjectStatus {
	return typeof value === "string" &&
		PROJECT_STATUSES.includes(value as ProjectStatus)
		? (value as ProjectStatus)
		: "planned";
}

function taskStatus(value: unknown): TaskStatus {
	return typeof value === "string" &&
		TASK_STATUSES.includes(value as TaskStatus)
		? (value as TaskStatus)
		: "todo";
}

function task(value: unknown, index: number): ProjectTask | null {
	if (!record(value)) {
		return null;
	}
	const title = stringValue(value.title).trim();
	if (!title) {
		return null;
	}
	return {
		dueDate: stringValue(value.dueDate),
		id: stringValue(value.id, `task-${index}`).trim() || `task-${index}`,
		owner: stringValue(value.owner, "Unassigned").trim() || "Unassigned",
		status: taskStatus(value.status),
		title,
	};
}

function project(value: unknown, index: number): Project | null {
	if (!record(value)) {
		return null;
	}
	const name = stringValue(value.name).trim();
	if (!name) {
		return null;
	}
	const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
	return {
		client: stringValue(value.client, "Internal").trim() || "Internal",
		description: stringValue(value.description).trim(),
		dueDate: stringValue(value.dueDate),
		id: stringValue(value.id, `project-${index}`).trim() || `project-${index}`,
		name,
		owner: stringValue(value.owner, "Unassigned").trim() || "Unassigned",
		status: projectStatus(value.status),
		tasks: rawTasks
			.map((item, taskIndex) => task(item, taskIndex))
			.filter((item): item is ProjectTask => item !== null)
			.slice(0, 200),
	};
}

export function emptyState(): ProjectsState {
	return { projects: [], schemaVersion: 1 };
}

export function normalizeState(value: unknown): ProjectsState {
	if (!record(value)) {
		return emptyState();
	}
	const rawProjects = Array.isArray(value.projects) ? value.projects : [];
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
	name: string;
	owner: string;
}

export function createProject(input: NewProjectInput): Project {
	const now = Date.now();
	return {
		client: input.client.trim() || "Internal",
		description: input.description.trim(),
		dueDate: input.dueDate,
		id: `project-${now}`,
		name: input.name.trim(),
		owner: input.owner.trim() || "Unassigned",
		status: "planned",
		tasks: [],
	};
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

export function projectStats(projects: Project[]): {
	active: number;
	openTasks: number;
	total: number;
} {
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

export function nextTaskStatus(status: TaskStatus): TaskStatus {
	const index = TASK_STATUSES.indexOf(status);
	return TASK_STATUSES[(index + 1) % TASK_STATUSES.length] ?? "todo";
}

export function statusLabel(status: ProjectStatus | TaskStatus): string {
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
		: new Intl.DateTimeFormat(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
			}).format(date);
}
