import {
	Add01Icon,
	CalendarCheckIn01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	PlayIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	RyuAppActions,
	RyuAppDetail,
	RyuAppEmpty,
	RyuAppField,
	RyuAppList,
	RyuAppListItem,
	RyuAppMain,
	RyuAppSection,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	addContext,
	createProjectRemote,
	createSubscription,
	createWorker,
	hydrateFromSharedContext,
	loadProjectSnapshot,
	loadProjectsState,
	notify,
	runCoordinator,
	saveProjectsState,
	syncToSharedContext,
	updateProject,
} from "./bridge.ts";
import {
	addTask,
	createProject,
	createTask,
	formatDueDate,
	nextTaskStatus,
	normalizeState,
	projectProgress,
	projectStats,
	statusLabel,
	updateTask,
} from "./model.ts";
import { ProjectCommitGate, persistProjectUpdate } from "./persistence.ts";
import type {
	ExecutionMode,
	Project,
	ProjectContextItem,
	ProjectStatus,
	ProjectSubscription,
	ProjectsState,
	ProjectWorker,
} from "./types.ts";

type Filter = "all" | ProjectStatus;

const FILTERS: Array<{ id: Filter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "active", label: "Active" },
	{ id: "planned", label: "Planned" },
	{ id: "blocked", label: "Blocked" },
	{ id: "done", label: "Done" },
];

interface NewProjectForm {
	client: string;
	cwd: string;
	description: string;
	dueDate: string;
	executionMode: ExecutionMode;
	name: string;
	owner: string;
}

const EMPTY_FORM: NewProjectForm = {
	client: "",
	cwd: "",
	description: "",
	dueDate: "",
	executionMode: "auto",
	name: "",
	owner: "",
};

function errorMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Something went wrong. Try again.";
}

function projectStatusVariant(
	status: ProjectStatus
): "default" | "secondary" | "destructive" | "outline" {
	if (status === "active") {
		return "default";
	}
	if (status === "done") {
		return "secondary";
	}
	if (status === "blocked") {
		return "destructive";
	}
	return "outline";
}

function taskStatusVariant(
	status: Project["tasks"][number]["status"]
): "default" | "secondary" | "outline" {
	return status === "done"
		? "secondary"
		: status === "doing"
			? "default"
			: "outline";
}

function executionLabel(mode: ExecutionMode | undefined): string {
	return mode === "cloud" ? "Cloud" : mode === "local" ? "Local" : "Auto";
}

export function App() {
	const [state, setState] = useState<ProjectsState | null>(null);
	const [mode, setMode] = useState<"demo" | "live">(() =>
		window.ryu ? "live" : "demo"
	);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [context, setContext] = useState<ProjectContextItem[]>([]);
	const [workers, setWorkers] = useState<ProjectWorker[]>([]);
	const [subscriptions, setSubscriptions] = useState<ProjectSubscription[]>([]);
	const [taskTitle, setTaskTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [contextTitle, setContextTitle] = useState("");
	const [contextContent, setContextContent] = useState("");
	const [workerTitle, setWorkerTitle] = useState("");
	const [workerTask, setWorkerTask] = useState("");
	const [subscriptionName, setSubscriptionName] = useState("");
	const [subscriptionKind, setSubscriptionKind] = useState("schedule");
	const [subscriptionSchedule, setSubscriptionSchedule] = useState("1h");
	const [newOpen, setNewOpen] = useState(false);
	const [newForm, setNewForm] = useState<NewProjectForm>(EMPTY_FORM);
	const [formError, setFormError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState(false);
	const projectCommitVersions = useRef(new Map<string, number>());
	const projectCommitGate = useRef(new ProjectCommitGate());
	const [savingProjectIds, setSavingProjectIds] = useState<Set<string>>(
		() => new Set()
	);

	const project = useMemo(
		() =>
			state?.projects.find((item) => item.id === selectedId) ??
			state?.projects[0] ??
			null,
		[state, selectedId]
	);
	const visibleProjects = useMemo(
		() =>
			state?.projects.filter(
				(item) => filter === "all" || item.status === filter
			) ?? [],
		[state, filter]
	);
	const stats = useMemo(() => projectStats(state?.projects ?? []), [state]);
	const projectSaving = project ? savingProjectIds.has(project.id) : false;

	const loadSnapshot = useCallback(
		async (projectId: string) => {
			if (mode !== "live") {
				setContext([]);
				setWorkers([]);
				setSubscriptions([]);
				return;
			}
			const snapshot = await loadProjectSnapshot(projectId);
			setState((current) =>
				current
					? {
							...current,
							projects: current.projects.map((item) =>
								item.id === snapshot.project.id ? snapshot.project : item
							),
						}
					: current
			);
			setContext(snapshot.context);
			setWorkers(snapshot.workers);
			setSubscriptions(snapshot.subscriptions);
		},
		[mode]
	);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			await hydrateFromSharedContext();
			const loaded = await loadProjectsState();
			setMode(loaded.mode);
			setState(loaded.state);
			setSelectedId(loaded.state.projects[0]?.id ?? null);
		} catch (cause) {
			setError(errorMessage(cause));
			setState(normalizeState(null));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!selectedId || mode !== "live") {
			return;
		}
		void loadSnapshot(selectedId).catch((cause) =>
			setError(errorMessage(cause))
		);
	}, [loadSnapshot, mode, selectedId]);

	const commitProject = useCallback(
		async (next: Project, patch: Partial<Project>): Promise<boolean> => {
			if (!state) {
				return false;
			}
			const previousProject = state.projects.find(
				(item) => item.id === next.id
			);
			if (!previousProject) {
				return false;
			}
			if (!projectCommitGate.current.begin(next.id)) {
				return false;
			}
			setSavingProjectIds(projectCommitGate.current.snapshot());
			const commitVersion =
				(projectCommitVersions.current.get(next.id) ?? 0) + 1;
			projectCommitVersions.current.set(next.id, commitVersion);
			setError(null);
			setState((current) =>
				current
					? {
							...current,
							projects: current.projects.map((item) =>
								item.id === next.id ? next : item
							),
						}
					: current
			);

			try {
				const result = await persistProjectUpdate({
					context,
					mode,
					nextProject: next,
					patch,
					previousState: state,
					saveProjectsState,
					syncToSharedContext,
					updateProject,
				});
				if (projectCommitVersions.current.get(next.id) !== commitVersion) {
					return result.persisted;
				}
				if (result.persisted) {
					setState((current) => {
						if (!current) {
							return current;
						}
						return {
							...current,
							projects: current.projects.map((item) =>
								item.id === result.project.id ? result.project : item
							),
						};
					});
					return true;
				}

				setState((current) => {
					if (!current) {
						return current;
					}
					return {
						...current,
						projects: current.projects.map((item) =>
							item.id === previousProject.id ? previousProject : item
						),
					};
				});
				setError(errorMessage(result.error));
				return false;
			} finally {
				projectCommitGate.current.end(next.id);
				setSavingProjectIds(projectCommitGate.current.snapshot());
			}
		},
		[context, mode, state]
	);

	function updateSelectedProject(patch: Partial<Project>) {
		if (!project) {
			return;
		}
		commitProject({ ...project, ...patch }, patch);
	}

	async function addProjectTask(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && taskTitle.trim() && state)) {
			return;
		}
		const next = addTask(state, project.id, createTask(taskTitle));
		const nextProject = next.projects.find((item) => item.id === project.id);
		if (
			!(
				nextProject &&
				(await commitProject(nextProject, {
					tasks: nextProject.tasks,
				}))
			)
		) {
			return;
		}
		setTaskTitle("");
		notify({ title: "Task added", variant: "success" });
	}

	async function createNewProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = newForm.name.trim();
		if (!name) {
			setFormError("Give the project a name.");
			return;
		}
		try {
			const next =
				mode === "live"
					? await createProjectRemote({ ...newForm, name })
					: createProject({ ...newForm, name });
			setState((current) => ({
				projects: [next, ...(current?.projects ?? [])],
				schemaVersion: 1,
			}));
			await syncToSharedContext(next, []);
			setSelectedId(next.id);
			setNewOpen(false);
			setNewForm(EMPTY_FORM);
			setFormError(null);
			notify({
				title: "Project created",
				description: next.name,
				variant: "success",
			});
		} catch (cause) {
			setFormError(errorMessage(cause));
		}
	}

	async function runProject() {
		if (!(project && prompt.trim())) {
			return;
		}
		setRunning(true);
		try {
			if (mode === "demo") {
				notify({
					description: "Connect this app to run a real coordinator turn.",
					title: "Preview coordinator",
					variant: "info",
				});
			} else {
				await runCoordinator(project.id, prompt.trim());
				setPrompt("");
				await loadSnapshot(project.id);
				notify({
					description: "The turn is visible in the project conversation.",
					title: "Coordinator dispatched",
					variant: "success",
				});
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setRunning(false);
		}
	}

	async function addProjectContext(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && contextTitle.trim() && contextContent.trim())) {
			return;
		}
		try {
			const item =
				mode === "live"
					? await addContext(project.id, {
							content: contextContent.trim(),
							kind: "note",
							title: contextTitle.trim(),
						})
					: {
							content: contextContent.trim(),
							id: `context-${Date.now()}`,
							kind: "note",
							projectId: project.id,
							title: contextTitle.trim(),
							updatedAt: Date.now(),
						};
			const nextContext = [item, ...context];
			setContext(nextContext);
			setContextTitle("");
			setContextContent("");
			await syncToSharedContext(project, nextContext);
			notify({ title: "Context saved", variant: "success" });
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	async function addProjectWorker(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && workerTitle.trim() && workerTask.trim())) {
			return;
		}
		try {
			if (mode === "live") {
				const worker = await createWorker(project.id, {
					task: workerTask.trim(),
					title: workerTitle.trim(),
				});
				setWorkers((current) => [worker, ...current]);
			} else {
				setWorkers((current) => [
					{
						conversationId: null,
						createdAt: Date.now(),
						id: `worker-${Date.now()}`,
						projectId: project.id,
						status: "preview",
						task: workerTask.trim(),
						title: workerTitle.trim(),
						updatedAt: Date.now(),
					},
					...current,
				]);
			}
			setWorkerTitle("");
			setWorkerTask("");
			notify({ title: "Worker dispatched", variant: "success" });
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	async function addProjectSubscription(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && subscriptionName.trim())) {
			return;
		}
		try {
			const subscription = await createSubscription(project.id, {
				enabled: true,
				kind: subscriptionKind,
				name: subscriptionName.trim(),
				schedule:
					subscriptionKind === "schedule" ? subscriptionSchedule : undefined,
			});
			setSubscriptions((current) => [subscription, ...current]);
			setSubscriptionName("");
			notify({
				title: "Subscription armed",
				description: subscription.kind,
				variant: "success",
			});
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	if (loading || !state) {
		return (
			<div className="projects-loading" role="status">
				Opening Projects…
			</div>
		);
	}

	return (
		<div className="projects-root">
			<RyuAppToolbar
				actions={
					<Button onClick={() => setNewOpen(true)} size="sm">
						<HugeiconsIcon aria-hidden="true" icon={Add01Icon} />
						New project
					</Button>
				}
				title="Projects"
			/>
			<RyuAppMain className="projects-main">
				{error ? (
					<div aria-live="polite" className="projects-alert" role="alert">
						<span>{error}</span>
						<Button
							onClick={() => setError(null)}
							size="xs"
							variant="ghost-muted"
						>
							Dismiss
						</Button>
					</div>
				) : null}
				<div className="projects-overview">
					<div>
						<h2>Direct the work, not the agents.</h2>
						<p>
							Every Project keeps a coordinator, shared context, workers, and
							recurring signals together.
						</p>
					</div>
					<div aria-label="Projects summary" className="projects-summary">
						<Badge variant="outline">
							{mode === "live" ? "Active node" : "Preview"}
						</Badge>
						<span>
							<strong>{stats.total}</strong> projects
						</span>
						<span>
							<strong>{stats.active}</strong> active
						</span>
						<span>
							<strong>{stats.openTasks}</strong> open tasks
						</span>
					</div>
				</div>

				<div className="projects-layout">
					<RyuAppSection
						className="projects-panel projects-list"
						title="Projects"
					>
						<div className="projects-filters">
							<NativeSelect
								aria-label="Project filter"
								onChange={(event) => setFilter(event.target.value as Filter)}
								value={filter}
							>
								{FILTERS.map((item) => (
									<NativeSelectOption key={item.id} value={item.id}>
										{item.id === "all" ? "All projects" : item.label}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						{visibleProjects.length > 0 ? (
							<RyuAppList
								aria-label="Saved projects"
								className="projects-listbox"
							>
								{visibleProjects.map((item) => (
									<RyuAppListItem
										accessories={
											<Badge variant={projectStatusVariant(item.status)}>
												{statusLabel(item.status)}
											</Badge>
										}
										key={item.id}
										onClick={() => setSelectedId(item.id)}
										selected={project?.id === item.id}
										subtitle={`${item.client || "Internal"} · ${formatDueDate(item.dueDate)}`}
										title={item.name}
									/>
								))}
							</RyuAppList>
						) : (
							<RyuAppEmpty
								description="Create a Project when the work will outlive one chat."
								title="No projects here"
							/>
						)}
					</RyuAppSection>

					{project ? (
						<RyuAppSection className="projects-panel projects-detail">
							<div className="projects-detail-heading">
								<div>
									<p className="projects-label">Project</p>
									<h2>{project.name}</h2>
									<p className="projects-muted">
										{project.description || "No description yet."}
									</p>
								</div>
								<div className="projects-heading-actions">
									<Badge variant={projectStatusVariant(project.status)}>
										{statusLabel(project.status)}
									</Badge>
									<Badge variant="outline">
										{executionLabel(project.executionMode)}
									</Badge>
									{projectSaving ? (
										<span className="projects-muted" role="status">
											Saving…
										</span>
									) : null}
								</div>
							</div>
							<div className="projects-detail-meta">
								<div>
									<p className="projects-label">Owner</p>
									<strong>{project.owner || "Unassigned"}</strong>
								</div>
								<div>
									<p className="projects-label">Due</p>
									<strong>{formatDueDate(project.dueDate)}</strong>
								</div>
								<div>
									<p className="projects-label">Coordinator</p>
									<strong>
										{project.coordinatorConversationId
											? "Persistent thread"
											: "Ready to start"}
									</strong>
								</div>
								<div>
									<p className="projects-label">Progress</p>
									<strong>{projectProgress(project)}%</strong>
								</div>
							</div>

							<div className="projects-coordinator">
								<div className="projects-section-heading">
									<div>
										<h3>Coordinator</h3>
										<p className="projects-muted">
											Ask for a feature, migration, or maintenance pass. The
											coordinator delegates durable workers.
										</p>
									</div>
									<HugeiconsIcon aria-hidden="true" icon={PlayIcon} />
								</div>
								<Textarea
									aria-label="Coordinator request"
									onChange={(event) => setPrompt(event.target.value)}
									placeholder="Describe the body of work this Project should take on…"
									value={prompt}
								/>
								<Button
									disabled={running || !prompt.trim()}
									onClick={() => void runProject()}
									size="sm"
								>
									<HugeiconsIcon
										aria-hidden="true"
										icon={running ? RefreshIcon : PlayIcon}
									/>
									{running ? "Dispatching…" : "Run coordinator"}
								</Button>
							</div>

							<div className="projects-tasks">
								<div className="projects-section-heading">
									<div>
										<h3>Tasks</h3>
										<p className="projects-muted">
											Keep the human-facing outcome visible while workers run.
										</p>
									</div>
									<Badge variant="outline">{project.tasks.length} total</Badge>
								</div>
								<form className="projects-task-form" onSubmit={addProjectTask}>
									<Input
										aria-label="New task"
										autoComplete="off"
										disabled={projectSaving}
										name="new-task"
										onChange={(event) => setTaskTitle(event.target.value)}
										placeholder="Add a task…"
										value={taskTitle}
									/>
									<Button disabled={projectSaving} size="sm" type="submit">
										Add task
									</Button>
								</form>
								{project.tasks.length > 0 ? (
									<div
										aria-label="Project tasks"
										className="projects-task-list"
										role="list"
									>
										{project.tasks.map((task) => (
											<div
												className="projects-task"
												key={task.id}
												role="listitem"
											>
												<HugeiconsIcon
													aria-hidden="true"
													className="projects-task-icon"
													icon={
														task.status === "done"
															? CheckmarkCircle02Icon
															: Clock01Icon
													}
												/>
												<span className="projects-task-copy">
													<strong>{task.title}</strong>
													<span>
														{task.owner} ·{" "}
														{task.dueDate
															? formatDueDate(task.dueDate)
															: "No due date"}
													</span>
												</span>
												<Button
													aria-label={`Move ${task.title} to next status`}
													disabled={projectSaving}
													onClick={() => {
														const next = updateTask(
															state,
															project.id,
															task.id,
															{ status: nextTaskStatus(task.status) }
														);
														const nextProject = next.projects.find(
															(item) => item.id === project.id
														);
														if (nextProject) {
															commitProject(nextProject, {
																tasks: nextProject.tasks,
															});
														}
													}}
													size="xs"
													variant="ghost-muted"
												>
													<Badge variant={taskStatusVariant(task.status)}>
														{statusLabel(task.status)}
													</Badge>
												</Button>
											</div>
										))}
									</div>
								) : (
									<p className="projects-empty-tasks">No tasks yet.</p>
								)}
							</div>

							<div className="projects-context">
								<div className="projects-section-heading">
									<div>
										<h3>Shared context</h3>
										<p className="projects-muted">
											Research, decisions, and instructions travel with this
											Project through Ryu Spaces.
										</p>
									</div>
									<Badge variant="outline">{context.length} notes</Badge>
								</div>
								<form
									className="projects-context-form"
									onSubmit={(event) => void addProjectContext(event)}
								>
									<Input
										aria-label="Context title"
										onChange={(event) => setContextTitle(event.target.value)}
										placeholder="Context title"
										value={contextTitle}
									/>
									<Textarea
										aria-label="Context content"
										onChange={(event) => setContextContent(event.target.value)}
										placeholder="What should every future worker know?"
										value={contextContent}
									/>
									<Button size="sm" type="submit">
										Save context
									</Button>
								</form>
								{context.length > 0 ? (
									<div className="projects-context-list">
										{context.slice(0, 4).map((item) => (
											<div className="projects-context-item" key={item.id}>
												<strong>{item.title}</strong>
												<span>{item.content}</span>
											</div>
										))}
									</div>
								) : (
									<p className="projects-empty-tasks">No shared context yet.</p>
								)}
							</div>
						</RyuAppSection>
					) : (
						<RyuAppSection className="projects-panel projects-detail">
							<RyuAppEmpty
								actions={
									<Button onClick={() => setNewOpen(true)}>
										<HugeiconsIcon aria-hidden="true" icon={Add01Icon} />
										Create project
									</Button>
								}
								description="Give a Project a durable outcome and a coordinator."
								title="Start a Project"
							/>
						</RyuAppSection>
					)}

					{project ? (
						<RyuAppDetail className="projects-panel projects-inspector">
							<div className="projects-inspector-heading">
								<p className="projects-label">Project operations</p>
								<h2>Keep the work moving.</h2>
								<p className="projects-muted">
									Workers and subscriptions stay attached to this Project.
								</p>
							</div>
							<div className="projects-inspector-block">
								<RyuAppField label="Status">
									<NativeSelect
										aria-label="Project status"
										disabled={projectSaving}
										onChange={(event) =>
											updateSelectedProject({
												status: event.target.value as ProjectStatus,
											})
										}
										value={project.status}
									>
										{(
											[
												"planned",
												"active",
												"blocked",
												"done",
											] as ProjectStatus[]
										).map((status) => (
											<NativeSelectOption key={status} value={status}>
												{statusLabel(status)}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</RyuAppField>
								<RyuAppField label="Owner">
									<Input
										aria-label="Project owner"
										disabled={projectSaving}
										onChange={(event) =>
											updateSelectedProject({ owner: event.target.value })
										}
										value={project.owner}
									/>
								</RyuAppField>
								<RyuAppField label="Execution">
									<NativeSelect
										aria-label="Project execution mode"
										disabled={projectSaving}
										onChange={(event) =>
											updateSelectedProject({
												executionMode: event.target.value as ExecutionMode,
											})
										}
										value={project.executionMode ?? "auto"}
									>
										<NativeSelectOption value="auto">
											Auto · active node
										</NativeSelectOption>
										<NativeSelectOption value="cloud">
											Cloud target
										</NativeSelectOption>
										<NativeSelectOption value="local">
											Local target
										</NativeSelectOption>
									</NativeSelect>
								</RyuAppField>
							</div>
							<div className="projects-inspector-block projects-progress">
								<div className="projects-inspector-label">
									<span>Task progress</span>
									<strong>{projectProgress(project)}%</strong>
								</div>
								<div aria-hidden="true" className="projects-progress-track">
									<span style={{ width: `${projectProgress(project)}%` }} />
								</div>
								<p className="projects-inline-note">
									<HugeiconsIcon
										aria-hidden="true"
										icon={CalendarCheckIn01Icon}
									/>
									<span>{formatDueDate(project.dueDate)}</span>
								</p>
							</div>
							<div className="projects-inspector-block">
								<div className="projects-section-heading">
									<div>
										<h3>Workers</h3>
										<p className="projects-muted">
											Durable turns dispatched by the coordinator.
										</p>
									</div>
									<Badge variant="outline">{workers.length}</Badge>
								</div>
								<form
									className="projects-mini-form"
									onSubmit={(event) => void addProjectWorker(event)}
								>
									<Input
										aria-label="Worker title"
										onChange={(event) => setWorkerTitle(event.target.value)}
										placeholder="Worker title"
										value={workerTitle}
									/>
									<Input
										aria-label="Worker task"
										onChange={(event) => setWorkerTask(event.target.value)}
										placeholder="Task for this worker"
										value={workerTask}
									/>
									<Button size="xs" type="submit">
										Dispatch worker
									</Button>
								</form>
								{workers.slice(0, 3).map((worker) => (
									<div className="projects-worker" key={String(worker.id)}>
										<strong>{String(worker.title)}</strong>
										<span>
											{String(worker.status)} ·{" "}
											{worker.conversationId ? "thread saved" : "preview"}
										</span>
									</div>
								))}
							</div>
							<div className="projects-inspector-block">
								<div className="projects-section-heading">
									<div>
										<h3>Subscriptions</h3>
										<p className="projects-muted">
											Schedules and Slack/PR webhook sources.
										</p>
									</div>
									<Badge variant="outline">{subscriptions.length}</Badge>
								</div>
								<form
									className="projects-mini-form"
									onSubmit={(event) => void addProjectSubscription(event)}
								>
									<Input
										aria-label="Subscription name"
										onChange={(event) =>
											setSubscriptionName(event.target.value)
										}
										placeholder="Subscription name"
										value={subscriptionName}
									/>
									<NativeSelect
										aria-label="Subscription kind"
										onChange={(event) =>
											setSubscriptionKind(event.target.value)
										}
										value={subscriptionKind}
									>
										<NativeSelectOption value="schedule">
											Schedule
										</NativeSelectOption>
										<NativeSelectOption value="slack">
											Slack webhook
										</NativeSelectOption>
										<NativeSelectOption value="pull_request">
											Pull request webhook
										</NativeSelectOption>
									</NativeSelect>
									{subscriptionKind === "schedule" ? (
										<Input
											aria-label="Subscription interval"
											onChange={(event) =>
												setSubscriptionSchedule(event.target.value)
											}
											placeholder="1h"
											value={subscriptionSchedule}
										/>
									) : null}
									<Button size="xs" type="submit">
										Arm subscription
									</Button>
								</form>
								{subscriptions.slice(0, 3).map((subscription) => (
									<div
										className="projects-worker"
										key={String(subscription.id)}
									>
										<strong>{String(subscription.name)}</strong>
										<span>
											{String(subscription.kind)} ·{" "}
											{subscription.lastStatus
												? String(subscription.lastStatus)
												: "ready"}
										</span>
									</div>
								))}
							</div>
							<RyuAppActions className="projects-inspector-actions">
								<Badge variant="outline">
									{mode === "live"
										? "Node-owned + Spaces context"
										: "Preview data"}
								</Badge>
							</RyuAppActions>
						</RyuAppDetail>
					) : null}
				</div>
			</RyuAppMain>

			<Dialog
				onOpenChange={(open) => {
					setNewOpen(open);
					if (!open) {
						setFormError(null);
					}
				}}
				open={newOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>New project</DialogTitle>
						<DialogDescription>
							Give the coordinator a durable body of work. The active Ryu node
							owns execution.
						</DialogDescription>
					</DialogHeader>
					<form
						className="projects-form"
						onSubmit={(event) => void createNewProject(event)}
					>
						<div className="projects-form-fields">
							<div>
								<Label htmlFor="new-project-name">Project name</Label>
								<Input
									autoComplete="off"
									id="new-project-name"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											name: event.target.value,
										}))
									}
									placeholder="e.g. Design system migration"
									value={newForm.name}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-client">Client or team</Label>
								<Input
									autoComplete="off"
									id="new-project-client"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											client: event.target.value,
										}))
									}
									placeholder="e.g. Northstar Labs"
									value={newForm.client}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-owner">Owner</Label>
								<Input
									autoComplete="off"
									id="new-project-owner"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											owner: event.target.value,
										}))
									}
									placeholder="e.g. Jiawei"
									value={newForm.owner}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-due-date">Due date</Label>
								<Input
									id="new-project-due-date"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											dueDate: event.target.value,
										}))
									}
									type="date"
									value={newForm.dueDate}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-mode">Execution target</Label>
								<NativeSelect
									id="new-project-mode"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											executionMode: event.target.value as ExecutionMode,
										}))
									}
									value={newForm.executionMode}
								>
									<NativeSelectOption value="auto">
										Auto · active node
									</NativeSelectOption>
									<NativeSelectOption value="cloud">
										Cloud target
									</NativeSelectOption>
									<NativeSelectOption value="local">
										Local target
									</NativeSelectOption>
								</NativeSelect>
							</div>
							<div>
								<Label htmlFor="new-project-cwd">Working folder</Label>
								<Input
									autoComplete="off"
									id="new-project-cwd"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											cwd: event.target.value,
										}))
									}
									placeholder="/path/to/repository"
									value={newForm.cwd}
								/>
							</div>
							<div className="projects-form-wide">
								<Label htmlFor="new-project-description">Description</Label>
								<Textarea
									id="new-project-description"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											description: event.target.value,
										}))
									}
									placeholder="What outcome should this Project deliver?"
									value={newForm.description}
								/>
							</div>
						</div>
						{formError ? (
							<p
								aria-live="polite"
								className="projects-form-error"
								role="alert"
							>
								{formError}
							</p>
						) : null}
						<DialogFooter>
							<Button type="submit">Create project</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
