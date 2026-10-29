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
import {
	modelDefaultCacheWarning,
	type PromptEditReach,
	promptEditCacheWarning,
} from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
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
	type CSSProperties,
	type SubmitEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	addContext,
	addMember,
	createProjectRemote,
	createSubscription,
	createWorker,
	hydrateFromSharedContext,
	loadProjectSnapshot,
	loadProjectsState,
	notify,
	removeMember,
	runCoordinator,
	saveDefaults,
	saveGuidance,
	saveMemberGoal,
	saveProjectsState,
	syncToSharedContext,
	updateProject,
} from "./bridge.ts";
import {
	addTask,
	createProject,
	createTask,
	formatDueDate,
	instructionsChange,
	MAX_INSTRUCTIONS_CHARS,
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
	ProjectDefaults,
	ProjectMemberKind,
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
	goal: string;
	name: string;
	owner: string;
}

const EMPTY_FORM: NewProjectForm = {
	client: "",
	cwd: "",
	description: "",
	dueDate: "",
	executionMode: "auto",
	goal: "",
	name: "",
	owner: "",
};

type BriefChoice = "inherit" | "off" | "on";

function briefChoice(value: boolean | null | undefined): BriefChoice {
	if (value === true) {
		return "on";
	}
	return value === false ? "off" : "inherit";
}

function briefValue(choice: BriefChoice): boolean | null {
	if (choice === "on") {
		return true;
	}
	return choice === "off" ? false : null;
}

/** A save that edits the system prompt, held until the user confirms the
 * prompt-cache reset it causes. */
interface PendingPromptEdit {
	apply: () => Promise<void>;
	description: string;
	title: string;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Something went wrong. Try again.";
}

function projectStatusVariant(
	status: Project["status"]
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

function executionLabel(mode: Project["executionMode"]): string {
	return mode === "cloud" ? "Cloud" : mode === "local" ? "Local" : "Auto";
}

interface ProjectProgressStyle extends CSSProperties {
	"--project-progress": string;
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
	const [memberKind, setMemberKind] = useState<ProjectMemberKind>("agent");
	const [memberId, setMemberId] = useState("");
	const [defaultsDraft, setDefaultsDraft] = useState<ProjectDefaults>({
		effort: "",
		model: "",
		provider: "",
	});
	const [goalDraft, setGoalDraft] = useState("");
	const [instructionsDraft, setInstructionsDraft] = useState("");
	const [briefDraft, setBriefDraft] = useState<BriefChoice>("inherit");
	const [memberGoalDrafts, setMemberGoalDrafts] = useState<
		Record<string, string>
	>({});
	const [pendingPromptEdit, setPendingPromptEdit] =
		useState<PendingPromptEdit | null>(null);
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
	const progressStyle: ProjectProgressStyle = {
		"--project-progress": `${project ? projectProgress(project) : 0}%`,
	};
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

	async function addProjectTask(event: SubmitEvent<HTMLFormElement>) {
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

	async function createNewProject(event: SubmitEvent<HTMLFormElement>) {
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
		setError(null);
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

	async function addProjectContext(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && contextTitle.trim() && contextContent.trim())) {
			return;
		}
		setError(null);
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

	useEffect(() => {
		setDefaultsDraft({
			effort: project?.defaults?.effort ?? "",
			model: project?.defaults?.model ?? "",
			provider: project?.defaults?.provider ?? "",
		});
	}, [
		project?.defaults?.effort,
		project?.defaults?.model,
		project?.defaults?.provider,
	]);

	// Keyed by project too, like the instructions draft below: two projects with
	// the same goal must not share an unsaved draft.
	const goalKey = `${project?.id ?? ""}\u0000${project?.goal ?? ""}\u0000${String(project?.briefReplies)}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: goalKey is the dependency; it changes exactly when the selected project, its goal or its brief setting do.
	useEffect(() => {
		setGoalDraft(project?.goal ?? "");
		setBriefDraft(briefChoice(project?.briefReplies));
	}, [goalKey]);

	// Keyed by project too: switching between two projects with the same
	// instructions must not carry an unsaved draft into the other project.
	const instructionsKey = `${project?.id ?? ""}\u0000${project?.instructions ?? ""}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: instructionsKey is the dependency; it changes exactly when the selected project or its instructions do.
	useEffect(() => {
		setInstructionsDraft(project?.instructions ?? "");
	}, [instructionsKey]);

	const memberGoalsKey = (project?.members ?? [])
		.filter((member) => member.kind === "agent")
		.map((member) => `${member.id}\u0000${member.goal ?? ""}`)
		.join("\u0001");
	// biome-ignore lint/correctness/useExhaustiveDependencies: memberGoalsKey is the dependency; it changes exactly when a bot member or its goal does.
	useEffect(() => {
		setMemberGoalDrafts(
			Object.fromEntries(
				(project?.members ?? [])
					.filter((member) => member.kind === "agent")
					.map((member) => [member.id, member.goal ?? ""])
			)
		);
	}, [memberGoalsKey]);

	/** Run a prompt-editing save now, or hold it behind the cache-reset
	 * confirmation when it would change a live project's prompt. */
	function confirmPromptEdit(
		changed: string[],
		reach: PromptEditReach,
		apply: () => Promise<void>
	) {
		holdForCacheReset(promptEditCacheWarning(changed, reach), apply);
	}

	function holdForCacheReset(
		warning: { description: string; title: string } | null,
		apply: () => Promise<void>
	) {
		if (!(mode === "live" && warning)) {
			void apply();
			return;
		}
		setPendingPromptEdit({ ...warning, apply });
	}

	function saveProjectGuidance(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!project) {
			return;
		}
		const goal = goalDraft.trim();
		const briefReplies = briefValue(briefDraft);
		const changed: string[] = [];
		if (goal !== (project.goal ?? "").trim()) {
			changed.push("The project goal");
		}
		if (briefReplies !== (project.briefReplies ?? null)) {
			changed.push("Brief replies");
		}
		if (changed.length === 0) {
			return;
		}
		confirmPromptEdit(changed, "project", async () => {
			try {
				replaceProject(
					mode === "live"
						? (await saveGuidance(project.id, { briefReplies, goal })).project
						: { ...project, briefReplies, goal }
				);
				notify({ title: "Project goal saved", variant: "success" });
			} catch (cause) {
				setError(errorMessage(cause));
			}
		});
	}

	function saveProjectInstructions(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!project) {
			return;
		}
		const instructions = instructionsChange(project, instructionsDraft);
		if (instructions === null) {
			return;
		}
		confirmPromptEdit(["The project instructions"], "project", async () => {
			try {
				replaceProject(
					mode === "live"
						? (await saveGuidance(project.id, { instructions })).project
						: { ...project, instructions }
				);
				notify({ title: "Project instructions saved", variant: "success" });
			} catch (cause) {
				setError(errorMessage(cause));
			}
		});
	}

	function saveProjectMemberGoal(agentId: string) {
		const member = project?.members?.find(
			(item) => item.kind === "agent" && item.id === agentId
		);
		if (!(project && member)) {
			return;
		}
		const goal = (memberGoalDrafts[agentId] ?? "").trim();
		if (goal === (member.goal ?? "").trim()) {
			return;
		}
		confirmPromptEdit(
			[`${member.name || member.id}'s goal`],
			"bot-in-project",
			async () => {
				try {
					replaceProject(
						mode === "live"
							? (await saveMemberGoal(project.id, agentId, goal)).project
							: {
									...project,
									members: (project.members ?? []).map((item) =>
										item.kind === "agent" && item.id === agentId
											? { ...item, goal }
											: item
									),
								}
					);
					notify({ title: "Bot goal saved", variant: "success" });
				} catch (cause) {
					setError(errorMessage(cause));
				}
			}
		);
	}

	function replaceProject(next: Project) {
		setState((current) =>
			current
				? {
						...current,
						projects: current.projects.map((item) =>
							item.id === next.id ? { ...item, ...next } : item
						),
					}
				: current
		);
	}

	async function addProjectMember(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		const id = memberId.trim();
		if (!(project && id)) {
			return;
		}
		try {
			if (mode === "live") {
				replaceProject(await addMember(project.id, { id, kind: memberKind }));
			} else {
				replaceProject({
					...project,
					members: [
						...(project.members ?? []).filter(
							(member) => !(member.kind === memberKind && member.id === id)
						),
						{ id, kind: memberKind, mainThreadId: null, name: id },
					],
				});
			}
			setMemberId("");
			notify({ title: "Member added", variant: "success" });
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	async function removeProjectMember(kind: ProjectMemberKind, id: string) {
		if (!project) {
			return;
		}
		try {
			if (mode === "live") {
				replaceProject(await removeMember(project.id, kind, id));
			} else {
				replaceProject({
					...project,
					members: (project.members ?? []).filter(
						(member) => !(member.kind === kind && member.id === id)
					),
				});
			}
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	function saveProjectDefaults(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!project) {
			return;
		}
		const defaults: ProjectDefaults = {
			effort: defaultsDraft.effort.trim(),
			model: defaultsDraft.model.trim(),
			provider: defaultsDraft.provider.trim(),
		};
		holdForCacheReset(
			modelDefaultCacheWarning(
				project.name,
				{
					model: project.defaults?.model ?? "",
					provider: project.defaults?.provider ?? "",
				},
				defaults
			),
			() => applyProjectDefaults(project, defaults)
		);
	}

	async function applyProjectDefaults(
		project: Project,
		defaults: ProjectDefaults
	) {
		try {
			replaceProject(
				mode === "live"
					? await saveDefaults(project.id, defaults)
					: { ...project, defaults }
			);
			notify({
				title: defaults.model
					? "Project defaults saved"
					: "Using node defaults",
				variant: "success",
			});
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}

	async function addProjectWorker(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && workerTitle.trim() && workerTask.trim())) {
			return;
		}
		setError(null);
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

	async function addProjectSubscription(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!(project && subscriptionName.trim())) {
			return;
		}
		setError(null);
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
								onChange={(event) =>
									setFilter(
										/* SAFETY: The rendered select options use only values from this domain union. */ event
											.target.value as Filter
									)
								}
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
												status:
													/* SAFETY: The rendered select options use only values from this domain union. */ event
														.target.value as ProjectStatus,
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
											] satisfies ProjectStatus[]
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
												executionMode:
													/* SAFETY: The rendered select options use only values from this domain union. */ event
														.target.value as ExecutionMode,
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
									<span
										className="w-(--project-progress)"
										style={progressStyle}
									/>
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
										<h3>Instructions</h3>
										<p className="projects-muted">
											Optional. Standing rules every thread in this project
											follows. Changing them resets the prompt cache once.
										</p>
									</div>
								</div>
								<form
									className="projects-form"
									onSubmit={(event) => saveProjectInstructions(event)}
								>
									<Label htmlFor="project-instructions">
										Project instructions
									</Label>
									<Textarea
										id="project-instructions"
										maxLength={MAX_INSTRUCTIONS_CHARS}
										onChange={(event) =>
											setInstructionsDraft(event.target.value)
										}
										placeholder="How should every bot in this project work?"
										value={instructionsDraft}
									/>
									<Button size="xs" type="submit">
										Save instructions
									</Button>
								</form>
							</div>
							<div className="projects-inspector-block">
								<div className="projects-section-heading">
									<div>
										<h3>Goals</h3>
										<p className="projects-muted">
											Optional. Every thread in this project carries the project
											goal, and each bot also gets its own goal here. Changing
											one resets the prompt cache once.
										</p>
									</div>
								</div>
								<form
									className="projects-form"
									onSubmit={(event) => saveProjectGuidance(event)}
								>
									<Label htmlFor="project-goal">Project goal</Label>
									<Textarea
										id="project-goal"
										maxLength={2000}
										onChange={(event) => setGoalDraft(event.target.value)}
										placeholder="What is this project trying to achieve?"
										value={goalDraft}
									/>
									<Label htmlFor="project-brief-replies">
										Main thread replies
									</Label>
									<NativeSelect
										id="project-brief-replies"
										onChange={(event) =>
											setBriefDraft(
												/* SAFETY: The rendered select options use only values from this domain union. */ event
													.target.value as BriefChoice
											)
										}
										value={briefDraft}
									>
										<NativeSelectOption value="inherit">
											Brief (default)
										</NativeSelectOption>
										<NativeSelectOption value="on">Brief</NativeSelectOption>
										<NativeSelectOption value="off">
											Full length
										</NativeSelectOption>
									</NativeSelect>
									<Button size="xs" type="submit">
										Save goal
									</Button>
								</form>
								{(project.members ?? [])
									.filter((member) => member.kind === "agent")
									.map((member) => (
										<form
											className="projects-mini-form"
											key={`goal:${member.id}`}
											onSubmit={(event) => {
												event.preventDefault();
												saveProjectMemberGoal(member.id);
											}}
										>
											<Input
												aria-label={`${member.name || member.id}'s goal in this project`}
												maxLength={2000}
												onChange={(event) =>
													setMemberGoalDrafts((current) => ({
														...current,
														[member.id]: event.target.value,
													}))
												}
												placeholder={`${member.name || member.id}'s goal here (optional)`}
												value={memberGoalDrafts[member.id] ?? ""}
											/>
											<Button size="xs" type="submit" variant="outline">
												Save
											</Button>
										</form>
									))}
							</div>
							<div className="projects-inspector-block">
								<div className="projects-section-heading">
									<div>
										<h3>Members</h3>
										<p className="projects-muted">
											Bots and Groups each get a main thread in this project.
										</p>
									</div>
									<Badge variant="outline">
										{project.members?.length ?? 0}
									</Badge>
								</div>
								<form
									className="projects-mini-form"
									onSubmit={(event) => void addProjectMember(event)}
								>
									<NativeSelect
										aria-label="Member kind"
										onChange={(event) =>
											setMemberKind(
												/* SAFETY: The rendered select options use only values from this domain union. */ event
													.target.value as ProjectMemberKind
											)
										}
										value={memberKind}
									>
										<NativeSelectOption value="agent">Bot</NativeSelectOption>
										<NativeSelectOption value="group">Group</NativeSelectOption>
										<NativeSelectOption value="user">Person</NativeSelectOption>
									</NativeSelect>
									<Input
										aria-label="Member id"
										onChange={(event) => setMemberId(event.target.value)}
										placeholder={
											memberKind === "group"
												? "Group id"
												: memberKind === "user"
													? "User id"
													: "Agent id"
										}
										value={memberId}
									/>
									<Button size="xs" type="submit">
										Add member
									</Button>
								</form>
								{(project.members ?? []).map((member) => (
									<div
										className="projects-worker"
										key={`${member.kind}:${member.id}`}
									>
										<strong>{member.name || member.id}</strong>
										<span>
											{member.kind === "agent"
												? "Bot"
												: member.kind === "group"
													? "Group"
													: "Person"}
											{member.mainThreadId ? " · main thread" : ""}
										</span>
										<Button
											aria-label={`Remove ${member.name || member.id}`}
											onClick={() =>
												void removeProjectMember(member.kind, member.id)
											}
											size="xs"
											variant="ghost"
										>
											Remove
										</Button>
									</div>
								))}
							</div>
							<div className="projects-inspector-block">
								<div className="projects-section-heading">
									<div>
										<h3>Model defaults</h3>
										<p className="projects-muted">
											Every thread in this project uses these unless a bot or
											session overrides them. Leave empty to use the node
											default.
										</p>
									</div>
								</div>
								<form
									className="projects-mini-form"
									onSubmit={(event) => saveProjectDefaults(event)}
								>
									<Input
										aria-label="Default provider"
										onChange={(event) =>
											setDefaultsDraft((current) => ({
												...current,
												provider: event.target.value,
											}))
										}
										placeholder="Provider (e.g. anthropic)"
										value={defaultsDraft.provider}
									/>
									<Input
										aria-label="Default model"
										onChange={(event) =>
											setDefaultsDraft((current) => ({
												...current,
												model: event.target.value,
											}))
										}
										placeholder="Model id"
										value={defaultsDraft.model}
									/>
									<NativeSelect
										aria-label="Default effort"
										onChange={(event) =>
											setDefaultsDraft((current) => ({
												...current,
												effort: event.target.value,
											}))
										}
										value={defaultsDraft.effort}
									>
										<NativeSelectOption value="">
											Inherit effort
										</NativeSelectOption>
										<NativeSelectOption value="low">Low</NativeSelectOption>
										<NativeSelectOption value="medium">
											Medium
										</NativeSelectOption>
										<NativeSelectOption value="high">High</NativeSelectOption>
									</NativeSelect>
									<Button size="xs" type="submit">
										Save defaults
									</Button>
								</form>
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
											executionMode:
												/* SAFETY: The rendered select options use only values from this domain union. */ event
													.target.value as ExecutionMode,
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
							<div className="projects-form-wide">
								<Label htmlFor="new-project-goal">Goal (optional)</Label>
								<Textarea
									id="new-project-goal"
									maxLength={2000}
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											goal: event.target.value,
										}))
									}
									placeholder="The outcome every thread in this project works toward"
									value={newForm.goal}
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

			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setPendingPromptEdit(null);
					}
				}}
				open={pendingPromptEdit !== null}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{pendingPromptEdit?.title}</DialogTitle>
						<DialogDescription>
							{pendingPromptEdit?.description}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							onClick={() => setPendingPromptEdit(null)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							onClick={() => {
								const pending = pendingPromptEdit;
								setPendingPromptEdit(null);
								if (pending) {
									void pending.apply();
								}
							}}
						>
							Apply now
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
