import { describe, expect, it } from "bun:test";
import { demoState } from "./model.ts";
import { ProjectCommitGate, persistProjectUpdate } from "./persistence.ts";

describe("project persistence", () => {
	it("blocks a second same-project commit until the first one finishes", () => {
		const gate = new ProjectCommitGate();

		expect(gate.begin("project-1")).toBe(true);
		expect(gate.begin("project-1")).toBe(false);
		expect(gate.begin("project-2")).toBe(true);
		expect(gate.snapshot()).toEqual(new Set(["project-1", "project-2"]));

		gate.end("project-1");
		expect(gate.begin("project-1")).toBe(true);
	});

	it("rolls back a live edit when the project API rejects", async () => {
		const previousState = demoState();
		const previousProject = previousState.projects[0];
		if (!previousProject) {
			throw new Error("Expected demo state to contain a project");
		}
		const nextProject = { ...previousProject, owner: "New owner" };
		let syncCalls = 0;

		const result = await persistProjectUpdate({
			context: [],
			mode: "live",
			nextProject,
			patch: { owner: nextProject.owner },
			previousState,
			saveProjectsState: async () => {
				throw new Error("Demo persistence should not run");
			},
			syncToSharedContext: async () => {
				syncCalls += 1;
			},
			updateProject: async () => {
				throw new Error("PATCH failed");
			},
		});

		expect(result.persisted).toBe(false);
		expect(result.state).toEqual(previousState);
		expect(syncCalls).toBe(0);
		if (result.persisted) {
			throw new Error("Expected the rejected edit to roll back");
		}
		expect(result.error).toBeInstanceOf(Error);
	});

	it("uses the server project after a live edit succeeds", async () => {
		const previousState = demoState();
		const previousProject = previousState.projects[0];
		if (!previousProject) {
			throw new Error("Expected demo state to contain a project");
		}
		const nextProject = { ...previousProject, status: "done" as const };
		const savedProject = { ...nextProject, updatedAt: 1234 };
		let syncedProjectId = "";

		const result = await persistProjectUpdate({
			context: [],
			mode: "live",
			nextProject,
			patch: { status: nextProject.status },
			previousState,
			saveProjectsState: async () => {
				throw new Error("Demo persistence should not run");
			},
			syncToSharedContext: async (project) => {
				syncedProjectId = project.id;
			},
			updateProject: async () => savedProject,
		});

		expect(result.persisted).toBe(true);
		if (!result.persisted) {
			throw new Error("Expected the live edit to persist");
		}
		expect(result.project).toEqual(savedProject);
		expect(result.state.projects[0]).toEqual(savedProject);
		expect(syncedProjectId).toBe(savedProject.id);
	});

	it("persists demo edits locally without calling the live API", async () => {
		const previousState = demoState();
		const previousProject = previousState.projects[0];
		if (!previousProject) {
			throw new Error("Expected demo state to contain a project");
		}
		const nextProject = { ...previousProject, owner: "Preview owner" };
		let savedStateProjects = 0;

		const result = await persistProjectUpdate({
			context: [],
			mode: "demo",
			nextProject,
			patch: { owner: nextProject.owner },
			previousState,
			saveProjectsState: async (state, mode) => {
				expect(mode).toBe("demo");
				savedStateProjects = state.projects.length;
			},
			syncToSharedContext: async () => {
				throw new Error("Demo edits should not sync remotely");
			},
			updateProject: async () => {
				throw new Error("Live API should not run in demo mode");
			},
		});

		expect(result.persisted).toBe(true);
		expect(savedStateProjects).toBe(previousState.projects.length);
		if (!result.persisted) {
			throw new Error("Expected the demo edit to persist");
		}
		expect(result.project.owner).toBe("Preview owner");
	});
});
