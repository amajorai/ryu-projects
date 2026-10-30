import { CalendarCheckIn01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RyuAppDetail, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { ProjectActions } from "./App-actions.ts";
import type { ProjectsData } from "./App-data.ts";
import type { ProjectGuidance } from "./App-guidance.ts";
import { ProjectInspectorOperations } from "./App-inspector-operations.tsx";
import type { BriefChoice, ProjectProgressStyle } from "./App-shared.ts";
import {
	formatDueDate,
	MAX_INSTRUCTIONS_CHARS,
	projectProgress,
	statusLabel,
} from "./model.ts";
import type {
	ExecutionMode,
	Project,
	ProjectMemberKind,
	ProjectStatus,
} from "./types.ts";

/** The project operations column: status, guidance, members and operations. */
export function ProjectInspector({
	actions,
	data,
	guidance,
	project,
}: {
	actions: ProjectActions;
	data: ProjectsData;
	guidance: ProjectGuidance;
	project: Project;
}) {
	const tl = useLiteralMessages();
	const { projectSaving, updateSelectedProject } = data;
	const {
		addProjectMember,
		memberId,
		memberKind,
		removeProjectMember,
		setMemberId,
		setMemberKind,
	} = actions;
	const {
		briefDraft,
		goalDraft,
		instructionsDraft,
		memberGoalDrafts,
		saveProjectGuidance,
		saveProjectInstructions,
		saveProjectMemberGoal,
		setBriefDraft,
		setGoalDraft,
		setInstructionsDraft,
		setMemberGoalDrafts,
	} = guidance;
	const progressStyle: ProjectProgressStyle = {
		"--project-progress": `${project ? projectProgress(project) : 0}%`,
	};
	return (
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
							["planned", "active", "blocked", "done"] satisfies ProjectStatus[]
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
						<NativeSelectOption value="cloud">Cloud target</NativeSelectOption>
						<NativeSelectOption value="local">Local target</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
			</div>
			<div className="projects-inspector-block projects-progress">
				<div className="projects-inspector-label">
					<span>Task progress</span>
					<strong>{projectProgress(project)}%</strong>
				</div>
				<div aria-hidden="true" className="projects-progress-track">
					<span className="w-(--project-progress)" style={progressStyle} />
				</div>
				<p className="projects-inline-note">
					<HugeiconsIcon aria-hidden="true" icon={CalendarCheckIn01Icon} />
					<span>{formatDueDate(project.dueDate)}</span>
				</p>
			</div>
			<div className="projects-inspector-block">
				<div className="projects-section-heading">
					<div>
						<h3>Instructions</h3>
						<p className="projects-muted">
							Optional. Standing rules every thread in this project follows.
							Changing them resets the prompt cache once.
						</p>
					</div>
				</div>
				<form
					className="projects-form"
					onSubmit={(event) => saveProjectInstructions(event)}
				>
					<Label htmlFor="project-instructions">Project instructions</Label>
					<Textarea
						id="project-instructions"
						maxLength={MAX_INSTRUCTIONS_CHARS}
						onChange={(event) => setInstructionsDraft(event.target.value)}
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
							Optional. Every thread in this project carries the project goal,
							and each bot also gets its own goal here. Changing one resets the
							prompt cache once.
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
					<Label htmlFor="project-brief-replies">Main thread replies</Label>
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
						<NativeSelectOption value="off">Full length</NativeSelectOption>
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
								aria-label={tl("{name}'s goal in this project", {
									name: member.name || member.id,
								})}
								maxLength={2000}
								onChange={(event) =>
									setMemberGoalDrafts((current) => ({
										...current,
										[member.id]: event.target.value,
									}))
								}
								placeholder={tl("{name}'s goal here (optional)", {
									name: member.name || member.id,
								})}
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
					<Badge variant="outline">{project.members?.length ?? 0}</Badge>
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
					<div className="projects-worker" key={`${member.kind}:${member.id}`}>
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
							aria-label={tl("Remove {name}", {
								name: member.name || member.id,
							})}
							onClick={() => void removeProjectMember(member.kind, member.id)}
							size="xs"
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				))}
			</div>
			<ProjectInspectorOperations
				actions={actions}
				data={data}
				guidance={guidance}
			/>
		</RyuAppDetail>
	);
}
