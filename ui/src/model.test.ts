import { describe, expect, it } from "bun:test";
import {
	addTask,
	demoState,
	nextTaskStatus,
	normalizeState,
	projectProgress,
	projectStats,
	updateTask,
} from "./model.ts";

describe("projects model", () => {
	it("normalizes malformed state while keeping valid projects", () => {
		const state = normalizeState({
			projects: [
				{ name: "Valid", tasks: [{ title: "Ship" }] },
				null,
				{ name: "" },
			],
		});

		expect(state.projects).toHaveLength(1);
		expect(state.projects[0]?.tasks[0]?.title).toBe("Ship");
	});

	it("calculates progress and advances task status in order", () => {
		const project = demoState().projects[0];
		expect(project).toBeDefined();
		if (!project) {
			return;
		}
		expect(projectProgress(project)).toBe(33);
		expect(nextTaskStatus("todo")).toBe("doing");
		expect(nextTaskStatus("doing")).toBe("done");
		expect(nextTaskStatus("done")).toBe("todo");
	});

	it("adds and updates a task without touching other projects", () => {
		const state = demoState();
		const first = state.projects[0];
		if (!first) {
			return;
		}
		const added = addTask(state, first.id, {
			dueDate: "",
			id: "new-task",
			owner: "Unassigned",
			status: "todo",
			title: "New handoff",
		});
		const updated = updateTask(added, first.id, "new-task", { status: "done" });

		expect(updated.projects[0]?.tasks.at(-1)?.status).toBe("done");
		expect(updated.projects[1]?.tasks).toEqual(state.projects[1]?.tasks);
	});

	it("summarizes active projects and open tasks", () => {
		const stats = projectStats(demoState().projects);
		expect(stats).toEqual({ active: 1, openTasks: 4, total: 3 });
	});
});
