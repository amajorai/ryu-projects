import { demoState, emptyState, normalizeState } from "./model.ts";
import type { ProjectsState } from "./types.ts";

const STORAGE_NAMESPACE = "projects";
const STORAGE_KEY = "state.v1";
const LOCAL_STORAGE_KEY = "ryu.projects.state.v1";

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

interface RyuBridge {
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

function parse(value: string | null): ProjectsState {
	if (!value) {
		return emptyState();
	}
	try {
		return normalizeState(JSON.parse(value));
	} catch {
		return emptyState();
	}
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
		// The host storage remains authoritative in live mode.
	}
}

export async function loadProjectsState(): Promise<{
	mode: AppMode;
	state: ProjectsState;
}> {
	const current = bridge();
	if (!current) {
		const local = localGet();
		return { mode: "demo", state: local ? parse(local) : demoState() };
	}
	if (!current.storage) {
		return { mode: "live", state: emptyState() };
	}
	const stored = await current.storage.get({
		key: STORAGE_KEY,
		namespace: STORAGE_NAMESPACE,
	});
	return { mode: "live", state: parse(stored) };
}

export async function saveProjectsState(
	state: ProjectsState,
	mode: AppMode
): Promise<void> {
	const value = JSON.stringify(state);
	localSet(value);
	if (mode === "demo") {
		return;
	}
	const current = bridge();
	if (!current?.storage) {
		throw new Error("Projects storage is not available for this app.");
	}
	await current.storage.set({
		key: STORAGE_KEY,
		namespace: STORAGE_NAMESPACE,
		value,
	});
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
