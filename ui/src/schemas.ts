import { z } from "zod";
import type {
	Project,
	ProjectContextItem,
	ProjectDefaults,
	ProjectSubscription,
	ProjectWorker,
} from "./types.ts";

export const projectJsonSchema = z.json();
const extra = projectJsonSchema.optional();
export const projectStatusSchema = z.enum([
	"planned",
	"active",
	"blocked",
	"done",
]);
export const taskStatusSchema = z.enum(["todo", "doing", "done"]);
export const executionModeSchema = z.enum(["auto", "cloud", "local"]);
export const projectTaskSchema = z
	.object({
		dueDate: z.string(),
		id: z.string(),
		owner: z.string(),
		status: z.string(),
		title: z.string(),
	})
	.catchall(extra);
export const projectDefaultsSchema = z
	.object({ effort: z.string(), model: z.string(), provider: z.string() })
	.catchall(extra);
export const projectMemberSchema = z
	.object({
		goal: z.string().optional(),
		id: z.string(),
		joinedAt: z.number().optional(),
		kind: z.enum(["agent", "group", "user"]),
		mainThreadId: z.string().nullish(),
		name: z.string(),
	})
	.catchall(extra);
export const projectSchema = z
	.object({
		briefReplies: z.boolean().nullish(),
		client: z.string(),
		coordinatorAgent: z.string().nullish(),
		coordinatorConversationId: z.string().nullish(),
		createdAt: z.number().optional(),
		cwd: z.string().nullish(),
		defaults: projectDefaultsSchema.optional(),
		description: z.string(),
		dueDate: z.string(),
		executionMode: z.string().optional(),
		goal: z.string().optional(),
		icon: projectJsonSchema.optional(),
		id: z.string(),
		instructions: z.string().optional(),
		members: z.array(projectMemberSchema).optional(),
		name: z.string(),
		owner: z.string(),
		status: z.string(),
		tasks: z.array(projectTaskSchema),
		updatedAt: z.number().optional(),
	})
	.catchall(extra) satisfies z.ZodType<Project>;
export const guidanceSaveSchema = z
	.object({ project: projectSchema, promptChanged: z.boolean() })
	.catchall(extra);
export const projectContextSchema = z
	.object({
		content: z.string(),
		id: z.string(),
		kind: z.string(),
		projectId: z.string(),
		title: z.string(),
		updatedAt: z.number(),
	})
	.catchall(extra) satisfies z.ZodType<ProjectContextItem>;
export const projectWorkerSchema = z
	.object({
		agentId: z.string().nullish(),
		conversationId: z.string().nullish(),
		createdAt: z.number(),
		id: z.string(),
		projectId: z.string(),
		status: z.string(),
		task: z.string(),
		title: z.string(),
		updatedAt: z.number(),
	})
	.catchall(extra) satisfies z.ZodType<ProjectWorker>;
export const projectSubscriptionSchema = z
	.object({
		enabled: z.boolean(),
		id: z.string(),
		kind: z.string(),
		lastRunAt: z.number().nullish(),
		lastStatus: z.string().nullish(),
		name: z.string(),
		nextRunAt: z.number().nullish(),
		projectId: z.string(),
		schedule: z.string().nullish(),
		updatedAt: z.number(),
	})
	.catchall(extra) satisfies z.ZodType<ProjectSubscription>;
export const projectSnapshotSchema = z
	.object({
		context: z.array(projectContextSchema),
		project: projectSchema,
		subscriptions: z.array(projectSubscriptionSchema),
		workers: z.array(projectWorkerSchema),
	})
	.catchall(extra);
export const bootstrapSchema = z
	.object({ projects: z.array(projectSchema).optional() })
	.catchall(extra);
export const coordinatorRunSchema = z
	.object({
		conversation_id: z.string().optional(),
		status: z.string().optional(),
	})
	.catchall(extra);
export const sharedProjectSchema = z
	.object({
		context: z.array(projectContextSchema).optional(),
		project: projectSchema.optional(),
	})
	.catchall(extra);
export const sharedProjectIdentitySchema = z
	.object({ project: z.object({ id: z.string().optional() }).optional() })
	.catchall(extra);
export const projectImportSchema = z
	.object({ imported: z.boolean(), project: projectSchema })
	.catchall(extra);
export type ProjectsReadback =
	| Project
	| ProjectContextItem
	| ProjectWorker
	| ProjectSubscription
	| ProjectSnapshotRecord
	| { projects?: Project[] }
	| { conversation_id?: string; status?: string }
	| { imported: boolean; project: Project };
export type ProjectsJson = z.output<typeof projectJsonSchema>;

const legacyTaskSchema = z
	.object({
		dueDate: z.string().catch(""),
		id: z.string().optional().catch(undefined),
		owner: z.string().catch("Unassigned"),
		status: taskStatusSchema.catch("todo"),
		title: z.string().catch(""),
	})
	.nullable()
	.catch(null);
export const legacyProjectSchema = z
	.object({
		client: z.string().catch("Internal"),
		coordinatorAgent: z.string().catch(""),
		coordinatorConversationId: z.string().catch(""),
		createdAt: z.number().optional().catch(undefined),
		cwd: z.string().catch(""),
		description: z.string().catch(""),
		dueDate: z.string().catch(""),
		executionMode: executionModeSchema.catch("auto"),
		id: z.string().optional().catch(undefined),
		name: z.string().catch(""),
		owner: z.string().catch("Unassigned"),
		status: projectStatusSchema.catch("planned"),
		tasks: z.array(legacyTaskSchema).catch([]),
		updatedAt: z.number().optional().catch(undefined),
	})
	.nullable()
	.catch(null);
export const legacyStateSchema = z
	.object({ projects: z.array(legacyProjectSchema).catch([]) })
	.catch({ projects: [] });
export type LegacyProject = z.output<typeof legacyProjectSchema>;
export type LegacyTask = z.output<typeof legacyTaskSchema>;
interface RawProjectsState {
	projects?: Array<Partial<Project> | ProjectsJson>;
}
export type ProjectsStateInput =
	| ProjectsJson
	| import("./types.ts").ProjectsState
	| RawProjectsState
	| undefined;

export function projectReadbackSchema<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>((value) => schema.safeParse(value).success);
}
export type ProjectsRequestBody =
	| Partial<Project>
	| { content: string; kind: string; title: string }
	| { prompt: string }
	| { agentId?: string; task: string; title: string }
	| { id: string; kind: "agent" | "group" | "user"; name?: string }
	| { enabled?: boolean; kind: string; name: string; schedule?: string }
	| {
			client: string;
			coordinatorAgent?: string | null;
			cwd?: string | null;
			description: string;
			dueDate: string;
			executionMode: string;
			goal?: string;
			name: string;
			owner: string;
	  }
	| ProjectDefaults
	| { context: ProjectContextItem[]; project: Project };

export interface ProjectSnapshotRecord {
	context: ProjectContextItem[];
	project: Project;
	subscriptions: ProjectSubscription[];
	workers: ProjectWorker[];
}
