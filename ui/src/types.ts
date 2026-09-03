export type ProjectStatus = "planned" | "active" | "blocked" | "done";
export type TaskStatus = "todo" | "doing" | "done";

export interface ProjectTask {
	dueDate: string;
	id: string;
	owner: string;
	status: TaskStatus;
	title: string;
}

export interface Project {
	client: string;
	description: string;
	dueDate: string;
	id: string;
	name: string;
	owner: string;
	status: ProjectStatus;
	tasks: ProjectTask[];
}

export interface ProjectsState {
	projects: Project[];
	schemaVersion: 1;
}
