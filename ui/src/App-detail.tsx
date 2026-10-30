import {
	CheckmarkCircle02Icon,
	Clock01Icon,
	PlayIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { ProjectActions } from "./App-actions.ts";
import type { ProjectsData } from "./App-data.ts";
import {
	executionLabel,
	projectStatusVariant,
	taskStatusVariant,
} from "./App-shared.ts";
import {
	formatDueDate,
	nextTaskStatus,
	projectProgress,
	statusLabel,
	updateTask,
} from "./model.ts";
import type { Project, ProjectsState } from "./types.ts";

/** The selected project's heading, coordinator, tasks and shared context. */
export function ProjectDetail({
	actions,
	data,
	project,
	state,
}: {
	actions: ProjectActions;
	data: ProjectsData;
	project: Project;
	state: ProjectsState;
}) {
	const tl = useLiteralMessages();
	const { commitProject, context, projectSaving } = data;
	const {
		addProjectContext,
		addProjectTask,
		contextContent,
		contextTitle,
		prompt,
		runProject,
		running,
		setContextContent,
		setContextTitle,
		setPrompt,
		setTaskTitle,
		taskTitle,
	} = actions;
	return (
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
							Ask for a feature, migration, or maintenance pass. The coordinator
							delegates durable workers.
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
					<Badge variant="outline">
						{tl("{count} total", { count: project.tasks.length })}
					</Badge>
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
							<div className="projects-task" key={task.id} role="listitem">
								<HugeiconsIcon
									aria-hidden="true"
									className="projects-task-icon"
									icon={
										task.status === "done" ? CheckmarkCircle02Icon : Clock01Icon
									}
								/>
								<span className="projects-task-copy">
									<strong>{task.title}</strong>
									<span>
										{task.owner} ·{" "}
										{task.dueDate ? formatDueDate(task.dueDate) : "No due date"}
									</span>
								</span>
								<Button
									aria-label={tl("Move {title} to next status", {
										title: task.title,
									})}
									disabled={projectSaving}
									onClick={() => {
										const next = updateTask(state, project.id, task.id, {
											status: nextTaskStatus(task.status),
										});
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
							Research, decisions, and instructions travel with this Project
							through Ryu Spaces.
						</p>
					</div>
					<Badge variant="outline">
						{tl("{count} notes", { count: context.length })}
					</Badge>
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
	);
}
