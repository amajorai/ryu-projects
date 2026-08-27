import {
	Add01Icon,
	CalendarCheckIn01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
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
	useState,
} from "react";
import {
	type AppMode,
	loadProjectsState,
	notify,
	saveProjectsState,
} from "./bridge.ts";
import {
	addTask,
	createProject,
	createTask,
	formatDueDate,
	nextTaskStatus,
	normalizeState,
	patchProject,
	projectProgress,
	projectStats,
	statusLabel,
	updateTask,
} from "./model.ts";
import type { Project, ProjectStatus, ProjectsState } from "./types.ts";

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
	description: string;
	dueDate: string;
	name: string;
	owner: string;
}

const EMPTY_FORM: NewProjectForm = {
	client: "",
	description: "",
	dueDate: "",
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

function matchesFilter(project: Project, filter: Filter): boolean {
	return filter === "all" || project.status === filter;
}

export function App() {
	const [state, setState] = useState<ProjectsState | null>(null);
	const [mode, setMode] = useState<AppMode>("demo");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [taskTitle, setTaskTitle] = useState("");
	const [newOpen, setNewOpen] = useState(false);
	const [newForm, setNewForm] = useState<NewProjectForm>(EMPTY_FORM);
	const [formError, setFormError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const project = useMemo(
		() =>
			state?.projects.find((item) => item.id === selectedId) ??
			state?.projects[0] ??
			null,
		[state, selectedId]
	);
	const visibleProjects = useMemo(
		() => state?.projects.filter((item) => matchesFilter(item, filter)) ?? [],
		[state, filter]
	);
	const stats = useMemo(() => projectStats(state?.projects ?? []), [state]);

	const commit = useCallback(
		(next: ProjectsState) => {
			setState(next);
			void saveProjectsState(next, mode).catch((cause) =>
				setError(errorMessage(cause))
			);
		},
		[mode]
	);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
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

	function updateSelectedProject(patch: Partial<Project>) {
		if (!(state && project)) {
			return;
		}
		commit(patchProject(state, project.id, patch));
	}

	function addProjectTask(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const title = taskTitle.trim();
		if (!(state && project && title)) {
			return;
		}
		commit(addTask(state, project.id, createTask(title)));
		setTaskTitle("");
		notify({ title: "Task added", variant: "success" });
	}

	function createNewProject(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = newForm.name.trim();
		if (!name) {
			setFormError("Give the project a name.");
			return;
		}
		if (!state) {
			return;
		}
		const nextProject = createProject({ ...newForm, name });
		commit({ ...state, projects: [nextProject, ...state.projects] });
		setSelectedId(nextProject.id);
		setNewOpen(false);
		setNewForm(EMPTY_FORM);
		setFormError(null);
		notify({
			title: "Project created",
			description: nextProject.name,
			variant: "success",
		});
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
						<h2>Work at a glance</h2>
						<p>Projects, owners, due dates, and the next task.</p>
					</div>
					<div aria-label="Projects summary" className="projects-summary">
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
										subtitle={`${item.client} · ${formatDueDate(item.dueDate)}`}
										title={item.name}
									/>
								))}
							</RyuAppList>
						) : (
							<RyuAppEmpty
								description="Create a project when there is a clear outcome to own."
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
								<Badge variant={projectStatusVariant(project.status)}>
									{statusLabel(project.status)}
								</Badge>
							</div>
							<div className="projects-detail-meta">
								<div>
									<p className="projects-label">Client</p>
									<strong>{project.client}</strong>
								</div>
								<div>
									<p className="projects-label">Owner</p>
									<strong>{project.owner}</strong>
								</div>
								<div>
									<p className="projects-label">Due</p>
									<strong>{formatDueDate(project.dueDate)}</strong>
								</div>
								<div>
									<p className="projects-label">Progress</p>
									<strong>{projectProgress(project)}%</strong>
								</div>
							</div>

							<div className="projects-tasks">
								<div className="projects-section-heading">
									<div>
										<h3>Tasks</h3>
										<p className="projects-muted">
											Move each task forward as the work changes.
										</p>
									</div>
									<Badge variant="outline">{project.tasks.length} total</Badge>
								</div>
								<form className="projects-task-form" onSubmit={addProjectTask}>
									<Input
										aria-label="New task"
										autoComplete="off"
										name="new-task"
										onChange={(event) => setTaskTitle(event.target.value)}
										placeholder="Add a task…"
										value={taskTitle}
									/>
									<Button size="sm" type="submit">
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
													onClick={() =>
														commit(
															updateTask(state, project.id, task.id, {
																status: nextTaskStatus(task.status),
															})
														)
													}
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
								description="Give a project an owner and a next task to make it real."
								title="Start a project"
							/>
						</RyuAppSection>
					)}

					{project ? (
						<RyuAppDetail className="projects-panel projects-inspector">
							<div className="projects-inspector-heading">
								<p className="projects-label">Project settings</p>
								<h2>Keep the next step clear.</h2>
								<p className="projects-muted">
									These fields stay with this project on the current Ryu node.
								</p>
							</div>
							<div className="projects-inspector-block">
								<RyuAppField label="Status">
									<NativeSelect
										aria-label="Project status"
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
										autoComplete="off"
										name="project-owner"
										onChange={(event) =>
											updateSelectedProject({ owner: event.target.value })
										}
										value={project.owner}
									/>
								</RyuAppField>
								<RyuAppField label="Due date">
									<Input
										aria-label="Project due date"
										name="project-due-date"
										onChange={(event) =>
											updateSelectedProject({ dueDate: event.target.value })
										}
										type="date"
										value={project.dueDate}
									/>
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
							<RyuAppActions className="projects-inspector-actions">
								<Badge variant="outline">
									{mode === "demo" ? "Preview data" : "Node-owned data"}
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
							Keep the first version small: one outcome, one owner, one due
							date.
						</DialogDescription>
					</DialogHeader>
					<form className="projects-form" onSubmit={createNewProject}>
						<div className="projects-form-fields">
							<div>
								<Label htmlFor="new-project-name">Project name</Label>
								<Input
									autoComplete="off"
									id="new-project-name"
									name="new-project-name"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											name: event.target.value,
										}))
									}
									placeholder="e.g. Customer onboarding…"
									value={newForm.name}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-client">Client or team</Label>
								<Input
									autoComplete="off"
									id="new-project-client"
									name="new-project-client"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											client: event.target.value,
										}))
									}
									placeholder="e.g. Northstar Labs…"
									value={newForm.client}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-owner">Owner</Label>
								<Input
									autoComplete="off"
									id="new-project-owner"
									name="new-project-owner"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											owner: event.target.value,
										}))
									}
									placeholder="e.g. Jiawei…"
									value={newForm.owner}
								/>
							</div>
							<div>
								<Label htmlFor="new-project-due-date">Due date</Label>
								<Input
									id="new-project-due-date"
									name="new-project-due-date"
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
							<div className="projects-form-wide">
								<Label htmlFor="new-project-description">Description</Label>
								<Textarea
									autoComplete="off"
									id="new-project-description"
									name="new-project-description"
									onChange={(event) =>
										setNewForm((current) => ({
											...current,
											description: event.target.value,
										}))
									}
									placeholder="What outcome should this project deliver?…"
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
