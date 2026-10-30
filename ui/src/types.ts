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
	status: string;
	title: string;
}

export type ProjectMemberKind = "agent" | "group" | "user";

/** A bot, Group, or human working on the project. */
export interface ProjectMember {
	/** Optional: what this bot works toward in this project (bots only). */
	goal?: string;
	id: string;
	joinedAt?: number;
	kind: ProjectMemberKind;
	/** The member's own main thread inside this project (bots and groups). */
	mainThreadId?: string | null;
	name: string;
}

/** Model defaults for every thread in the project (Core resolves them). */
export interface ProjectDefaults {
	effort: string;
	model: string;
	provider: string;
}

export interface Project {
	/** Optional: whether the project's main threads answer briefly (unset = on). */
	briefReplies?: boolean | null;
	client: string;
	coordinatorAgent?: string | null;
	coordinatorConversationId?: string | null;
	createdAt?: number;
	cwd?: string | null;
	defaults?: ProjectDefaults;
	description: string;
	dueDate: string;
	executionMode?: string;
	/** Optional: what the project is for. Every member thread carries it. */
	goal?: string;
	icon?: unknown;
	id: string;
	/** Optional: standing instructions. Every member thread's system prompt
	 * carries them. */
	instructions?: string;
	members?: ProjectMember[];
	name: string;
	owner: string;
	status: string;
	tasks: ProjectTask[];
	updatedAt?: number;
}

export interface ProjectsState {
	projects: Project[];
	schemaVersion: 1;
}
