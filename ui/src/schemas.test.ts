import { describe, expect, it } from "bun:test";
import { demoState, nextTaskStatus, normalizeState } from "./model.ts";
import {
	type ProjectSnapshotRecord,
	projectReadbackSchema,
	projectSchema,
	projectSnapshotSchema,
} from "./schemas.ts";
import type { Project } from "./types.ts";

describe("Projects boundary contracts", () => {
	it("keeps legacy defaults, source indices and valid entries in malformed saved state", () => {
		const state = normalizeState({
			projects: [
				null,
				{
					name: "  Legacy  ",
					id: " ",
					client: " ",
					owner: null,
					status: "future",
					executionMode: "future",
					createdAt: 17,
					updatedAt: "later",
					tasks: [
						null,
						{
							title: "  Ship  ",
							id: " ",
							owner: "",
							status: "future",
							dueDate: 42,
						},
						{ title: " " },
					],
				},
			],
		});
		expect(state.projects).toHaveLength(1);
		expect(state.projects.at(0)).toMatchObject({
			name: "Legacy",
			id: "project-1",
			client: "Internal",
			owner: "Unassigned",
			status: "planned",
			executionMode: "auto",
			createdAt: 17,
			updatedAt: undefined,
			tasks: [
				{
					title: "Ship",
					id: "task-1",
					owner: "Unassigned",
					status: "todo",
					dueDate: "",
				},
			],
		});
		expect(normalizeState(null)).toEqual({ projects: [], schemaVersion: 1 });
		expect(normalizeState({ projects: "bad" })).toEqual({
			projects: [],
			schemaVersion: 1,
		});
	});
	it("preserves Core's open status and execution labels and original readback objects", () => {
		const base = demoState().projects.at(0);
		if (!base) {
			throw new Error("Expected demo project");
		}
		const project: Project = {
			...base,
			executionMode: "future-node",
			status: "archived",
			tasks: [
				{
					dueDate: "",
					id: "task-1",
					owner: "",
					status: "paused",
					title: "Task",
				},
			],
		};
		const snapshot = {
			context: [],
			project,
			subscriptions: [],
			workers: [],
			metadata: { source: "Core" },
		};
		const parsedProject: Project =
			projectReadbackSchema(projectSchema).parse(project);
		expect(parsedProject).toBe(project);
		const parsedSnapshot: ProjectSnapshotRecord = projectReadbackSchema(
			projectSnapshotSchema
		).parse(snapshot);
		expect(parsedSnapshot).toBe(snapshot);
		expect(nextTaskStatus("paused")).toBe("todo");
	});
	it("rejects incomplete or malformed server records without coercing their fields", () => {
		expect(
			projectSchema.safeParse({ id: "project-1", name: "Partial" }).success
		).toBe(false);
		const base = demoState().projects.at(0);
		if (!base) {
			throw new Error("Expected demo project");
		}
		expect(projectSchema.safeParse({ ...base, createdAt: "17" }).success).toBe(
			false
		);
	});
});
