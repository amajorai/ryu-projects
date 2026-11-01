import { type SubmitEvent, useState } from "react";
import type { ProjectsData } from "./App-data.ts";
import { EMPTY_FORM, errorMessage, type NewProjectForm } from "./App-shared.ts";
import {
	addContext,
	addMember,
	createProjectRemote,
	createSubscription,
	createWorker,
	notify,
	removeMember,
	runCoordinator,
	syncToSharedContext,
} from "./bridge.ts";
import { addTask, createProject, createTask } from "./model.ts";
import type { ProjectMemberKind } from "./types.ts";

/** Form drafts and the actions that add tasks, context, members, workers,
 * subscriptions and new projects. */
export function useProjectActions(data: ProjectsData) {
	const {
		commitProject,
		context,
		loadSnapshot,
		mode,
		project,
		replaceProject,
		setContext,
		setError,
		setSelectedId,
		setState,
		setSubscriptions,
		setWorkers,
		state,
	} = data;
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
	const [newOpen, setNewOpen] = useState(false);
	const [newForm, setNewForm] = useState<NewProjectForm>(EMPTY_FORM);
	const [formError, setFormError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);

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

	return {
		addProjectContext,
		addProjectMember,
		addProjectSubscription,
		addProjectTask,
		addProjectWorker,
		contextContent,
		contextTitle,
		createNewProject,
		formError,
		memberId,
		memberKind,
		newForm,
		newOpen,
		prompt,
		removeProjectMember,
		runProject,
		running,
		setContextContent,
		setContextTitle,
		setFormError,
		setMemberId,
		setMemberKind,
		setNewForm,
		setNewOpen,
		setPrompt,
		setSubscriptionKind,
		setSubscriptionName,
		setSubscriptionSchedule,
		setTaskTitle,
		setWorkerTask,
		setWorkerTitle,
		subscriptionKind,
		subscriptionName,
		subscriptionSchedule,
		taskTitle,
		workerTask,
		workerTitle,
	};
}

export type ProjectActions = ReturnType<typeof useProjectActions>;
