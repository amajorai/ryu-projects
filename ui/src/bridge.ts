import { demoState, emptyState, normalizeState } from "./model.ts";
import type {
	Project,
	ProjectContextItem,
	ProjectSubscription,
	ProjectsState,
	ProjectWorker,
} from "./types.ts";

const LOCAL_STORAGE_KEY = "ryu.projects.state.v1";

interface AppRequest {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST";
	path: string;
}

interface RyuStorage {
	get(input: { key: string; namespace?: string }): Promise<string | null>;
	set(input: { key: string; namespace?: string; value: string }): Promise<void>;
}

interface RyuToast {
	show(input: {
		description?: string;
		title: string;
		variant?: "default" | "success" | "error" | "info";
	}): Promise<string>;
}

interface RyuSpaces {
	createDoc(input: { space_id: string; title: string }): Promise<string>;
	ensureSpace(input: { description?: string; name: string }): Promise<string>;
	getDoc(input: { doc_id: string }): Promise<{
		id: string;
		source: string;
		title: string;
	} | null>;
	listDocs(input: {
		space_id: string;
	}): Promise<Array<{ id: string; title: string; updated_at: number }>>;
	updateDoc(input: {
		doc_id: string;
		title?: string;
		source: string;
	}): Promise<void>;
}

interface RyuBridge {
	app?: { request(input: AppRequest): Promise<unknown> };
	spaces?: RyuSpaces;
	storage?: RyuStorage;
	ui?: { toast?: RyuToast };
}

declare global {
	interface Window {
		ryu?: RyuBridge;
	}
}

export type AppMode = "demo" | "live";

function bridge(): RyuBridge | null {
	return typeof window === "undefined" ? null : (window.ryu ?? null);
}

function localGet(): string | null {
	try {
		return globalThis.localStorage.getItem(LOCAL_STORAGE_KEY);
	} catch {
		return null;
	}
}

function localSet(value: string): void {
	try {
		globalThis.localStorage.setItem(LOCAL_STORAGE_KEY, value);
	} catch {
		// Preview state is best-effort browser state.
	}
}

async function request<T>(
	path: string,
	method: AppRequest["method"] = "GET",
	body?: unknown
): Promise<T> {
	const appRequest = bridge()?.app?.request;
	if (!appRequest) {
		throw new Error("Projects sidecar is unavailable on this host.");
	}
	return (await appRequest({ body, method, path })) as T;
}

export async function loadProjectsState(): Promise<{
	mode: AppMode;
	state: ProjectsState;
}> {
	if (!bridge()) {
		const local = localGet();
		return { mode: "demo", state: local ? parseLocal(local) : demoState() };
	}
	const payload = await request<{ projects?: unknown[] }>("/bootstrap");
	return {
		mode: "live",
		state: normalizeState({ projects: payload.projects ?? [] }),
	};
}

function parseLocal(value: string): ProjectsState {
	try {
		return normalizeState(JSON.parse(value));
	} catch {
		return emptyState();
	}
}

export async function loadProjectSnapshot(projectId: string): Promise<{
	context: ProjectContextItem[];
	project: Project;
	subscriptions: ProjectSubscription[];
	workers: ProjectWorker[];
}> {
	return request(`/projects/${encodeURIComponent(projectId)}`);
}

export function updateProject(
	projectId: string,
	patch: Partial<Project>
): Promise<Project> {
	return request(`/projects/${encodeURIComponent(projectId)}`, "PATCH", patch);
}

export function createProjectRemote(input: {
	client: string;
	coordinatorAgent?: string | null;
	cwd?: string | null;
	description: string;
	dueDate: string;
	executionMode: string;
	name: string;
	owner: string;
}): Promise<Project> {
	return request("/projects", "POST", input);
}

export function addContext(
	projectId: string,
	input: { content: string; kind: string; title: string }
): Promise<ProjectContextItem> {
	return request(
		`/projects/${encodeURIComponent(projectId)}/context`,
		"POST",
		input
	);
}

export function runCoordinator(
	projectId: string,
	prompt: string
): Promise<{ conversation_id?: string; status?: string }> {
	return request(`/projects/${encodeURIComponent(projectId)}/run`, "POST", {
		prompt,
	});
}

export function createWorker(
	projectId: string,
	input: { agentId?: string; task: string; title: string }
): Promise<ProjectWorker> {
	return request(
		`/projects/${encodeURIComponent(projectId)}/workers`,
		"POST",
		input
	);
}

export function createSubscription(
	projectId: string,
	input: { enabled?: boolean; kind: string; name: string; schedule?: string }
): Promise<ProjectSubscription> {
	return request(
		`/projects/${encodeURIComponent(projectId)}/subscriptions`,
		"POST",
		input
	);
}

export async function hydrateFromSharedContext(): Promise<void> {
	const current = bridge();
	if (!(current?.spaces && current.app?.request)) {
		return;
	}
	try {
		const spaceId = await current.spaces.ensureSpace({
			description: "Shared context for Ryu Projects coordinators and workers.",
			name: "Projects",
		});
		const docs = await current.spaces.listDocs({ space_id: spaceId });
		for (const summary of docs) {
			const doc = await current.spaces.getDoc({ doc_id: summary.id });
			if (!doc?.source) {
				continue;
			}
			try {
				const record = JSON.parse(doc.source) as {
					project?: Project;
					context?: ProjectContextItem[];
				};
				if (!record.project?.id) {
					continue;
				}
				await request("/projects/import", "POST", {
					context: record.context ?? [],
					project: record.project,
				});
			} catch {
				// Other app documents in the shared Space are not Projects records.
			}
		}
	} catch {
		// Shared context is an enhancement; the node-owned project remains usable.
	}
}

export async function syncToSharedContext(
	project: Project,
	context: ProjectContextItem[]
): Promise<void> {
	const current = bridge();
	if (!current?.spaces) {
		return;
	}
	try {
		const spaceId = await current.spaces.ensureSpace({
			description: "Shared context for Ryu Projects coordinators and workers.",
			name: "Projects",
		});
		const source = JSON.stringify({ context, project });
		const docs = await current.spaces.listDocs({ space_id: spaceId });
		let docId: string | undefined;
		for (const summary of docs) {
			const doc = await current.spaces.getDoc({ doc_id: summary.id });
			if (!doc?.source) {
				continue;
			}
			try {
				const record = JSON.parse(doc.source) as { project?: { id?: string } };
				if (record.project?.id === project.id) {
					docId = summary.id;
					break;
				}
			} catch {
				// Ignore unrelated app docs.
			}
		}
		if (!docId) {
			docId = await current.spaces.createDoc({
				space_id: spaceId,
				title: `Project · ${project.name}`,
			});
		}
		await current.spaces.updateDoc({
			doc_id: docId,
			title: `Project · ${project.name}`,
			source,
		});
	} catch {
		// A disconnected sync mirror must not make a local project unusable.
	}
}

export async function saveProjectsState(
	state: ProjectsState,
	mode: AppMode
): Promise<void> {
	if (mode !== "demo") {
		throw new Error(
			"Live Projects state is server-owned; save an individual Project through its API."
		);
	}
	localSet(JSON.stringify(state));
}

export function notify(input: {
	description?: string;
	title: string;
	variant?: "default" | "success" | "error" | "info";
}): void {
	const show = bridge()?.ui?.toast?.show;
	if (!show) {
		return;
	}
	try {
		void show(input).catch(() => undefined);
	} catch {
		// A toast should never block a project edit.
	}
}
