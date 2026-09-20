export type ProjectStatus = "planned" | "active" | "blocked" | "done";
export type TaskStatus = "todo" | "doing" | "done";
export type ExecutionMode = "auto" | "cloud" | "local";

export interface ProjectContextItem {
	content: string;
	id: string;
	kind: string;
	projectId: string;
	title: string;
	updatedAt: number;
}

export interface ProjectWorker {
	agentId?: string | null;
	conversationId?: string | null;
	createdAt: number;
	id: string;
	projectId: string;
	status: string;
	task: string;
	title: string;
	updatedAt: number;
}

export interface ProjectSubscription {
	enabled: boolean;
	id: string;
	kind: string;
	lastRunAt?: number | null;
	lastStatus?: string | null;
	name: string;
	nextRunAt?: number | null;
	projectId: string;
	schedule?: string | null;
	updatedAt: number;
}

export interface ProjectTask {
	dueDate: string;
	id: string;
	owner: string;
	status: TaskStatus;
	title: string;
}

export interface Project {
	client: string;
	coordinatorAgent?: string | null;
	coordinatorConversationId?: string | null;
	createdAt?: number;
	cwd?: string | null;
	description: string;
	dueDate: string;
	executionMode?: ExecutionMode;
	id: string;
	name: string;
	owner: string;
	status: ProjectStatus;
	tasks: ProjectTask[];
	updatedAt?: number;
}

export interface ProjectsState {
	projects: Project[];
	schemaVersion: 1;
}
