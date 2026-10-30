import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, type Filter } from "./App-shared.ts";
import {
	hydrateFromSharedContext,
	loadProjectSnapshot,
	loadProjectsState,
	saveProjectsState,
	syncToSharedContext,
	updateProject,
} from "./bridge.ts";
import { normalizeState, projectStats } from "./model.ts";
import { ProjectCommitGate, persistProjectUpdate } from "./persistence.ts";
import type {
	Project,
	ProjectContextItem,
	ProjectSubscription,
	ProjectsState,
	ProjectWorker,
} from "./types.ts";

/** Projects state, the selected project's snapshot, and the commit path. */
export function useProjectsData() {
	const [state, setState] = useState<ProjectsState | null>(null);
	const [mode, setMode] = useState<"demo" | "live">(() =>
		window.ryu ? "live" : "demo"
	);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [context, setContext] = useState<ProjectContextItem[]>([]);
	const [workers, setWorkers] = useState<ProjectWorker[]>([]);
	const [subscriptions, setSubscriptions] = useState<ProjectSubscription[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
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

	return {
		commitProject,
		context,
		error,
		filter,
		loadSnapshot,
		loading,
		mode,
		project,
		projectSaving,
		replaceProject,
		selectedId,
		setContext,
		setError,
		setFilter,
		setSelectedId,
		setState,
		setSubscriptions,
		setWorkers,
		state,
		stats,
		subscriptions,
		updateSelectedProject,
		visibleProjects,
		workers,
	};
}

export type ProjectsData = ReturnType<typeof useProjectsData>;
