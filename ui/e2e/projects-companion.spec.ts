import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

import type { AppRequest, RyuToast } from "../src/bridge.ts";
import type { ProjectSnapshotRecord } from "../src/schemas.ts";
import type {
	Project,
	ProjectContextItem,
	ProjectSubscription,
	ProjectWorker,
} from "../src/types.ts";

type FixtureProject = Project;
interface FixtureRequest {
	body?: AppRequest["body"];
	method: string;
	path: string;
}
interface ProjectsFixture {
	failNext: Record<string, number>;
	projects: FixtureProject[];
	requests: FixtureRequest[];
	snapshots: Record<string, ProjectSnapshotRecord>;
	toasts: Parameters<RyuToast["show"]>[0][];
}
declare global {
	interface Window {
		__projectsFixture?: ProjectsFixture;
	}
}

const DEFAULT_PROJECTS: FixtureProject[] = [
	{
		client: "Northstar Labs",
		coordinatorAgent: null,
		coordinatorConversationId: null,
		createdAt: 1_790_000_000_000,
		cwd: "/work/northstar",
		description: "Prepare the launch plan and implementation handoff.",
		dueDate: "2026-10-14",
		executionMode: "auto",
		id: "project-alpha",
		name: "Northstar rollout",
		owner: "Maya",
		status: "active",
		tasks: [
			{
				dueDate: "2026-10-02",
				id: "task-draft",
				owner: "Maya",
				status: "todo",
				title: "Draft the launch brief",
			},
		],
		updatedAt: 1_790_000_000_000,
	},
	{
		client: "Ryu",
		createdAt: 1_790_000_000_100,
		cwd: "/work/service",
		description: "Document the service recovery path.",
		dueDate: "2026-11-04",
		executionMode: "local",
		id: "project-beta",
		name: "Service migration",
		owner: "Jordan",
		status: "blocked",
		tasks: [],
		updatedAt: 1_790_000_000_100,
	},
];

async function openProjects(
	page: Page,
	options: {
		failNext?: Record<string, number>;
		projects?: FixtureProject[];
	} = {}
) {
	const projects = structuredClone(options.projects ?? DEFAULT_PROJECTS);
	await page.addInitScript(
		({ seedProjects, failNext }) => {
			const snapshots: ProjectsFixture["snapshots"] = Object.fromEntries(
				seedProjects.map((project) => [
					project.id,
					{
						context: [],
						project: structuredClone(project),
						subscriptions: [],
						workers: [],
					},
				])
			);
			const fixture: ProjectsFixture = {
				failNext: { ...failNext },
				projects: structuredClone(seedProjects),
				requests: [],
				snapshots,
				toasts: [],
			};
			window.__projectsFixture = fixture;
			window.ryu = {
				app: {
					request: async (input) => {
						const method = input.method ?? "GET";
						fixture.requests.push({
							body: input.body,
							method,
							path: input.path,
						});
						const failureKey = `${method} ${input.path}`;
						const remainingFailures = fixture.failNext[failureKey] ?? 0;
						if (remainingFailures > 0) {
							fixture.failNext[failureKey] = remainingFailures - 1;
							throw new Error(`Fixture rejected ${failureKey}`);
						}
						if (method === "GET" && input.path === "/bootstrap") {
							return { projects: structuredClone(fixture.projects) };
						}
						const projectPath = input.path.match(/^\/projects\/([^/]+)$/);
						if (method === "GET" && projectPath) {
							const id = decodeURIComponent(projectPath[1] ?? "");
							const saved = fixture.snapshots[id];
							if (!saved) {
								throw new Error(`Unknown fixture project ${id}`);
							}
							return structuredClone(saved);
						}
						if (method === "POST" && input.path === "/projects") {
							const body = input.body;
							if (!body) {
								throw new Error("Missing create-project body");
							}
							const id = `project-created-${fixture.projects.length + 1}`;
							const project: FixtureProject = {
								client: "client" in body ? (body.client ?? "") : "",
								description:
									"description" in body ? (body.description ?? "") : "",
								dueDate: "dueDate" in body ? (body.dueDate ?? "") : "",
								executionMode:
									"executionMode" in body
										? (body.executionMode ?? "auto")
										: "auto",
								name: "name" in body ? (body.name ?? "") : "",
								owner: "owner" in body ? (body.owner ?? "") : "",
								cwd: "cwd" in body ? (body.cwd ?? null) : null,
								coordinatorAgent: null,
								coordinatorConversationId: null,
								createdAt: 1_790_000_100_000,
								id,
								status: "planned",
								tasks: [],
								updatedAt: 1_790_000_100_000,
							};
							fixture.projects.unshift(project);
							fixture.snapshots[id] = {
								context: [],
								project: structuredClone(project),
								subscriptions: [],
								workers: [],
							};
							return structuredClone(project);
						}
						if (method === "PATCH" && projectPath) {
							const id = decodeURIComponent(projectPath[1] ?? "");
							const saved = fixture.snapshots[id];
							if (!saved) {
								throw new Error(`Unknown fixture project ${id}`);
							}
							const project = {
								...saved.project,
								...input.body,
							};
							saved.project = project;
							fixture.projects = fixture.projects.map((item) =>
								item.id === id ? project : item
							);
							return structuredClone(project);
						}
						const childPath = input.path.match(
							/^\/projects\/([^/]+)\/(context|run|workers|subscriptions)$/
						);
						if (method === "POST" && childPath) {
							const id = decodeURIComponent(childPath[1] ?? "");
							const child = childPath[2];
							const saved = fixture.snapshots[id];
							if (!saved) {
								throw new Error(`Unknown fixture project ${id}`);
							}
							const body = input.body;
							if (!body) {
								throw new Error("Missing child request body");
							}
							if (child === "context") {
								if (!("content" in body && "kind" in body && "title" in body)) {
									throw new Error("Malformed context fixture request");
								}
								const item: ProjectContextItem = {
									content: body.content,
									kind: body.kind,
									title: body.title,
									id: `context-${saved.context.length + 1}`,
									projectId: id,
									updatedAt: 1_790_000_200_000,
								};
								saved.context.unshift(item);
								return structuredClone(item);
							}
							if (child === "run") {
								saved.project = {
									...saved.project,
									coordinatorConversationId: "conversation-fixture-1",
								};
								fixture.projects = fixture.projects.map((item) =>
									item.id === id ? saved.project : item
								);
								return {
									conversation_id: "conversation-fixture-1",
									status: "queued",
								};
							}
							if (child === "workers") {
								if (!("task" in body && "title" in body)) {
									throw new Error("Malformed worker fixture request");
								}
								const worker: ProjectWorker = {
									agentId: body.agentId,
									task: body.task,
									title: body.title,
									conversationId: "worker-conversation-1",
									createdAt: 1_790_000_300_000,
									id: "worker-fixture-1",
									projectId: id,
									status: "queued",
									updatedAt: 1_790_000_300_000,
								};
								saved.workers.unshift(worker);
								return structuredClone(worker);
							}
							if (!("kind" in body && "name" in body)) {
								throw new Error("Malformed subscription fixture request");
							}
							const subscription: ProjectSubscription = {
								enabled: "enabled" in body ? (body.enabled ?? true) : true,
								kind: body.kind,
								name: body.name ?? "",
								schedule: "schedule" in body ? (body.schedule ?? null) : null,
								id: "subscription-fixture-1",
								lastStatus: "ready",
								projectId: id,
								updatedAt: 1_790_000_400_000,
							};
							saved.subscriptions.unshift(subscription);
							return structuredClone(subscription);
						}
						const membersPath = input.path.match(
							/^\/projects\/([^/]+)\/members(?:\/([^/]+)\/([^/]+))?$/
						);
						const defaultsPath = input.path.match(
							/^\/projects\/([^/]+)\/defaults$/
						);
						const settingsPath = membersPath ?? defaultsPath;
						if (settingsPath) {
							const id = decodeURIComponent(settingsPath[1] ?? "");
							const saved = fixture.snapshots[id];
							if (!saved) {
								throw new Error(`Unknown fixture project ${id}`);
							}
							const body = input.body;
							let project = saved.project;
							if (defaultsPath && method === "PUT") {
								if (
									!(
										body &&
										"effort" in body &&
										"model" in body &&
										"provider" in body
									)
								) {
									throw new Error("Malformed defaults fixture request");
								}
								project = {
									...project,
									defaults: {
										effort: body.effort,
										model: body.model,
										provider: body.provider,
									},
								};
							} else if (membersPath && method === "POST" && !membersPath[2]) {
								if (!(body && "id" in body && "kind" in body)) {
									throw new Error("Malformed member fixture request");
								}
								const memberId = String(body.id);
								const kind = body.kind;
								if (kind !== "agent" && kind !== "group" && kind !== "user") {
									throw new Error("Unknown fixture member kind");
								}
								// The host resolves the display name and main thread.
								project = {
									...project,
									members: [
										...(project.members ?? []).filter(
											(member) =>
												!(member.kind === kind && member.id === memberId)
										),
										{
											id: memberId,
											kind,
											mainThreadId:
												kind === "user" ? null : `thread-${memberId}`,
											name:
												memberId === "launch-crew" ? "Launch crew" : memberId,
										},
									],
								};
							} else if (membersPath && method === "DELETE" && membersPath[2]) {
								const kind = decodeURIComponent(membersPath[2]);
								const memberId = decodeURIComponent(membersPath[3] ?? "");
								project = {
									...project,
									members: (project.members ?? []).filter(
										(member) =>
											!(member.kind === kind && member.id === memberId)
									),
								};
							} else {
								throw new Error(`Unhandled fixture request ${failureKey}`);
							}
							saved.project = project;
							fixture.projects = fixture.projects.map((item) =>
								item.id === id ? project : item
							);
							return structuredClone(project);
						}
						throw new Error(`Unhandled fixture request ${failureKey}`);
					},
				},
				ui: {
					toast: {
						show: async (input) => {
							fixture.toasts.push(input);
							return "fixture-toast";
						},
					},
				},
			};
		},
		{ failNext: options.failNext ?? {}, seedProjects: projects }
	);
	await page.goto("/");
	await expect(
		page.getByRole("heading", { level: 1, name: "Projects", exact: true })
	).toBeVisible();
}

async function waitForRequests(
	page: Page,
	method: string,
	path: string,
	count: number
) {
	await expect
		.poll(() =>
			page.evaluate(
				({ expectedMethod, expectedPath }) =>
					window.__projectsFixture?.requests.filter(
						(item) =>
							item.method === expectedMethod && item.path === expectedPath
					).length ?? 0,
				{ expectedMethod: method, expectedPath: path }
			)
		)
		.toBeGreaterThanOrEqual(count);
}

async function requestsFor(page: Page, method: string, path: string) {
	return page.evaluate(
		({ expectedMethod, expectedPath }) =>
			window.__projectsFixture?.requests.filter(
				(item) => item.method === expectedMethod && item.path === expectedPath
			) ?? [],
		{ expectedMethod: method, expectedPath: path }
	);
}

async function saveScreenshot(page: Page, name: string) {
	const directory = join(process.cwd(), "e2e", "screenshots");
	mkdirSync(directory, { recursive: true });
	await page.setViewportSize({ height: 1280, width: 1440 });
	await page.screenshot({ fullPage: true, path: join(directory, name) });
}

test("creates a project from the toolbar and persists the exact project fields", async ({
	page,
}) => {
	await openProjects(page);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	// New project dialog and Create project dialog form are the visible entry points.
	await page.getByLabel("Project name").fill("Atlas rollout");
	await page.getByLabel("Client or team").fill("Acme Studio");
	await dialog.getByLabel("Owner").fill("Sam Lee");
	await page.getByLabel("Due date").fill("2026-12-18");
	await page.getByLabel("Execution target").selectOption("cloud");
	await page.getByLabel("Working folder").fill("/workspace/atlas");
	await page
		.getByLabel("Description")
		.fill("Ship the reviewed onboarding path.");
	await dialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();

	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Atlas rollout", exact: true })
	).toBeVisible();
	await waitForRequests(page, "POST", "/projects", 1);
	const createRequests = await requestsFor(page, "POST", "/projects");
	expect(createRequests[0]?.body).toEqual({
		client: "Acme Studio",
		cwd: "/workspace/atlas",
		description: "Ship the reviewed onboarding path.",
		dueDate: "2026-12-18",
		executionMode: "cloud",
		name: "Atlas rollout",
		owner: "Sam Lee",
	});

	await page.getByLabel("Project status").selectOption("blocked");
	await waitForRequests(page, "PATCH", "/projects/project-created-3", 1);
	await expect(page.getByLabel("Project status")).toHaveValue("blocked");
	await page.getByLabel("Project owner").fill("Taylor Quinn");
	await waitForRequests(page, "PATCH", "/projects/project-created-3", 2);
	await expect(page.getByText("Taylor Quinn", { exact: true })).toBeVisible();
	await page.getByLabel("Project execution mode").selectOption("local");
	await waitForRequests(page, "PATCH", "/projects/project-created-3", 3);
	await expect(page.getByLabel("Project execution mode")).toHaveValue("local");
	const updates = await requestsFor(
		page,
		"PATCH",
		"/projects/project-created-3"
	);
	expect(updates.map((item) => item.body)).toEqual([
		{ status: "blocked" },
		{ owner: "Taylor Quinn" },
		{ executionMode: "local" },
	]);
	await saveScreenshot(page, "project-created-metadata-edited.png");
});

test("filters projects and opens the selected project detail", async ({
	page,
}) => {
	await openProjects(page);
	await page.getByLabel("Project filter").selectOption("blocked");
	const savedProjects = page.getByRole("listbox", { name: "Saved projects" });
	await expect(
		savedProjects.getByRole("option", { name: /Service migration/ })
	).toBeVisible();
	await expect(
		savedProjects.getByRole("option", { name: /Northstar rollout/ })
	).toHaveCount(0);
	await savedProjects
		.getByRole("option", { name: /Service migration/ })
		.click();
	await expect(
		page.getByRole("heading", { name: "Service migration", exact: true })
	).toBeVisible();
	await waitForRequests(page, "GET", "/projects/project-beta", 1);
	await saveScreenshot(page, "filtered-project-selected.png");
});

test("keeps a task after a failed save, lets the user retry, and advances task status", async ({
	page,
}) => {
	await openProjects(page, {
		failNext: { "PATCH /projects/project-alpha": 1 },
	});
	const newTask = page.getByLabel("New task");
	await newTask.fill("Prepare launch notes");
	await page.getByRole("button", { name: "Add task", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Fixture rejected PATCH");
	await expect(newTask).toHaveValue("Prepare launch notes");
	await expect(
		page
			.getByRole("list", { name: "Project tasks" })
			.getByText("Prepare launch notes")
	).toHaveCount(0);
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Add task", exact: true }).click();
	await waitForRequests(page, "PATCH", "/projects/project-alpha", 2);
	const taskList = page.getByRole("list", { name: "Project tasks" });
	await expect(taskList.getByText("Prepare launch notes")).toBeVisible();
	await expect(newTask).toHaveValue("");

	await page
		.getByRole("button", { name: "Move Prepare launch notes to next status" })
		.click();
	await expect(taskList.getByText("In progress")).toBeVisible();
	await waitForRequests(page, "PATCH", "/projects/project-alpha", 3);
	const saves = await requestsFor(page, "PATCH", "/projects/project-alpha");
	expect(saves[1]?.body).toEqual(
		expect.objectContaining({
			tasks: expect.arrayContaining([
				expect.objectContaining({
					title: "Prepare launch notes",
					status: "todo",
				}),
			]),
		})
	);
	expect(saves[2]?.body).toEqual(
		expect.objectContaining({
			tasks: expect.arrayContaining([
				expect.objectContaining({
					title: "Prepare launch notes",
					status: "doing",
				}),
			]),
		})
	);
	await saveScreenshot(page, "task-retried-and-in-progress.png");
});

test("saves context, retries coordinator and subscription requests, and dispatches a worker", async ({
	page,
}) => {
	await openProjects(page, {
		failNext: {
			"POST /projects/project-alpha/context": 1,
			"POST /projects/project-alpha/run": 1,
			"POST /projects/project-alpha/subscriptions": 1,
		},
	});

	await page.getByLabel("Context title").fill("Launch guardrails");
	await page
		.getByLabel("Context content")
		.fill("Use the approved checklist before release.");
	await page.getByRole("button", { name: "Save context", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Fixture rejected POST");
	await expect(page.getByLabel("Context title")).toHaveValue(
		"Launch guardrails"
	);
	await page.getByRole("button", { name: "Save context", exact: true }).click();
	await expect(
		page.getByText("Launch guardrails", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	const contextRequests = await requestsFor(
		page,
		"POST",
		"/projects/project-alpha/context"
	);
	expect(contextRequests[1]?.body).toEqual({
		content: "Use the approved checklist before release.",
		kind: "note",
		title: "Launch guardrails",
	});

	const coordinatorRequest = page.getByLabel("Coordinator request");
	await coordinatorRequest.fill(
		"Review the launch checklist and report blockers."
	);
	await page
		.getByRole("button", { name: "Run coordinator", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("Fixture rejected POST");
	await expect(coordinatorRequest).toHaveValue(
		"Review the launch checklist and report blockers."
	);
	await page
		.getByRole("button", { name: "Run coordinator", exact: true })
		.click();
	await expect(
		page.getByText("Persistent thread", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	const runRequests = await requestsFor(
		page,
		"POST",
		"/projects/project-alpha/run"
	);
	expect(runRequests[1]?.body).toEqual({
		prompt: "Review the launch checklist and report blockers.",
	});

	await page.getByLabel("Worker title").fill("Docs worker");
	await page.getByLabel("Worker task").fill("Update the onboarding guide.");
	await page
		.getByRole("button", { name: "Dispatch worker", exact: true })
		.click();
	await expect(page.getByText("Docs worker", { exact: true })).toBeVisible();
	const workerRequests = await requestsFor(
		page,
		"POST",
		"/projects/project-alpha/workers"
	);
	expect(workerRequests[0]?.body).toEqual({
		task: "Update the onboarding guide.",
		title: "Docs worker",
	});

	await page.getByLabel("Subscription name").fill("Launch digest");
	await page.getByLabel("Subscription kind").selectOption("schedule");
	await page.getByLabel("Subscription interval").fill("30m");
	await page
		.getByRole("button", { name: "Arm subscription", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("Fixture rejected POST");
	await expect(page.getByLabel("Subscription name")).toHaveValue(
		"Launch digest"
	);
	await page
		.getByRole("button", { name: "Arm subscription", exact: true })
		.click();
	await expect(page.getByText("Launch digest", { exact: true })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	const subscriptionRequests = await requestsFor(
		page,
		"POST",
		"/projects/project-alpha/subscriptions"
	);
	expect(subscriptionRequests[1]?.body).toEqual({
		enabled: true,
		kind: "schedule",
		name: "Launch digest",
		schedule: "30m",
	});
	await saveScreenshot(page, "context-coordinator-worker-subscription.png");
});

test("adds and removes a project member and saves model defaults through the host", async ({
	page,
}) => {
	await openProjects(page);
	await waitForRequests(page, "GET", "/projects/project-alpha", 1);
	const memberForm = page.locator("form").filter({
		has: page.getByLabel("Member id"),
	});
	const memberId = memberForm.getByLabel("Member id");
	await memberForm.getByLabel("Member kind").selectOption("group");
	await expect(memberId).toHaveAttribute("placeholder", "Group id");
	await memberId.fill("launch-crew");
	await memberForm
		.getByRole("button", { name: "Add member", exact: true })
		.click();
	await waitForRequests(page, "POST", "/projects/project-alpha/members", 1);
	const memberWrites = await requestsFor(
		page,
		"POST",
		"/projects/project-alpha/members"
	);
	expect(memberWrites.map((item) => item.body)).toEqual([
		{ id: "launch-crew", kind: "group" },
	]);
	const removeMember = page.getByRole("button", {
		name: "Remove Launch crew",
		exact: true,
	});
	await expect(removeMember).toBeVisible();
	await expect(
		page.getByText("Group · main thread", { exact: true })
	).toBeVisible();
	await expect(memberId).toHaveValue("");
	await removeMember.click();
	await waitForRequests(
		page,
		"DELETE",
		"/projects/project-alpha/members/group/launch-crew",
		1
	);
	await expect(removeMember).toHaveCount(0);

	const defaultsForm = page.locator("form").filter({
		has: page.getByLabel("Default model"),
	});
	await defaultsForm.getByLabel("Default provider").fill("  anthropic ");
	await defaultsForm.getByLabel("Default model").fill("fixture-model");
	await defaultsForm.getByLabel("Default effort").selectOption("high");
	await defaultsForm
		.getByRole("button", { name: "Save defaults", exact: true })
		.click();
	await waitForRequests(page, "PUT", "/projects/project-alpha/defaults", 1);
	const defaultsWrites = await requestsFor(
		page,
		"PUT",
		"/projects/project-alpha/defaults"
	);
	expect(defaultsWrites.map((item) => item.body)).toEqual([
		{ effort: "high", model: "fixture-model", provider: "anthropic" },
	]);
	await expect(defaultsForm.getByLabel("Default provider")).toHaveValue(
		"anthropic"
	);
	await expect(defaultsForm.getByLabel("Default effort")).toHaveValue("high");
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__projectsFixture?.toasts.map((toast) => toast.title) ?? []
			)
		)
		.toEqual(["Member added", "Project defaults saved"]);
});

test("opens project creation from the empty-state action", async ({ page }) => {
	await openProjects(page, { projects: [] });
	await expect(
		page.getByRole("heading", { name: "No projects here" })
	).toBeVisible();
	// Create project is the recovery path when the filtered list is empty.
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByLabel("Project name")).toBeVisible();
	await saveScreenshot(page, "empty-project-create-dialog.png");
});
