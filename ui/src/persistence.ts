import type { AppMode } from "./bridge.ts";
import { patchProject } from "./model.ts";
import type { Project, ProjectContextItem, ProjectsState } from "./types.ts";

export class ProjectCommitGate {
	private readonly pendingProjectIds = new Set<string>();

	begin(projectId: string): boolean {
		if (this.pendingProjectIds.has(projectId)) {
			return false;
		}
		this.pendingProjectIds.add(projectId);
		return true;
	}

	end(projectId: string): void {
		this.pendingProjectIds.delete(projectId);
	}

	snapshot(): Set<string> {
		return new Set(this.pendingProjectIds);
	}
}

export interface PersistProjectUpdateInput {
	context: ProjectContextItem[];
	mode: AppMode;
	nextProject: Project;
	patch: Partial<Project>;
	previousState: ProjectsState;
	saveProjectsState: (state: ProjectsState, mode: AppMode) => Promise<void>;
	syncToSharedContext: (
		project: Project,
		context: ProjectContextItem[]
	) => Promise<void>;
	updateProject: (
		projectId: string,
		patch: Partial<Project>
	) => Promise<Project>;
}

export type PersistProjectUpdateResult =
	| {
			persisted: true;
			project: Project;
			state: ProjectsState;
	  }
	| {
			error: unknown;
			persisted: false;
			state: ProjectsState;
	  };

/** Persist one optimistic project edit and return the authoritative outcome. */
export async function persistProjectUpdate(
	input: PersistProjectUpdateInput
): Promise<PersistProjectUpdateResult> {
	const optimisticState = patchProject(
		input.previousState,
		input.nextProject.id,
		input.nextProject
	);

	if (input.mode === "demo") {
		try {
			await input.saveProjectsState(optimisticState, input.mode);
			return {
				persisted: true,
				project: input.nextProject,
				state: optimisticState,
			};
		} catch (error) {
			return { error, persisted: false, state: input.previousState };
		}
	}

	let savedProject: Project;
	try {
		savedProject = await input.updateProject(input.nextProject.id, input.patch);
	} catch (error) {
		return { error, persisted: false, state: input.previousState };
	}

	// Shared Space is a mirror. A failed mirror must not turn a confirmed
	// node-owned project write into a failed edit.
	try {
		await input.syncToSharedContext(savedProject, input.context);
	} catch {
		// The next explicit sync can repair an unavailable mirror.
	}

	return {
		persisted: true,
		project: savedProject,
		state: patchProject(optimisticState, savedProject.id, savedProject),
	};
}
