import {
	modelDefaultCacheWarning,
	type PromptEditReach,
	promptEditCacheWarning,
} from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { type SubmitEvent, useEffect, useState } from "react";
import type { ProjectsData } from "./App-data.ts";
import {
	type BriefChoice,
	briefChoice,
	briefValue,
	errorMessage,
	type PendingPromptEdit,
} from "./App-shared.ts";
import {
	notify,
	saveDefaults,
	saveGuidance,
	saveMemberGoal,
} from "./bridge.ts";
import { instructionsChange } from "./model.ts";
import type { Project, ProjectDefaults } from "./types.ts";

/** Prompt-shaping drafts (goals, instructions, model defaults) and the saves
 * that hold behind the prompt-cache reset confirmation. */
export function useProjectGuidance(data: ProjectsData) {
	const { mode, project, replaceProject, setError } = data;
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

	return {
		briefDraft,
		defaultsDraft,
		goalDraft,
		instructionsDraft,
		memberGoalDrafts,
		pendingPromptEdit,
		saveProjectDefaults,
		saveProjectGuidance,
		saveProjectInstructions,
		saveProjectMemberGoal,
		setBriefDraft,
		setDefaultsDraft,
		setGoalDraft,
		setInstructionsDraft,
		setMemberGoalDrafts,
		setPendingPromptEdit,
	};
}

export type ProjectGuidance = ReturnType<typeof useProjectGuidance>;
