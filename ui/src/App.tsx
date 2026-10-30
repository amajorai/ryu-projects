import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	RyuAppEmpty,
	RyuAppList,
	RyuAppListItem,
	RyuAppMain,
	RyuAppSection,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useProjectActions } from "./App-actions.ts";
import { useProjectsData } from "./App-data.ts";
import { ProjectDetail } from "./App-detail.tsx";
import { NewProjectDialog, PromptEditDialog } from "./App-dialogs.tsx";
import { useProjectGuidance } from "./App-guidance.ts";
import { ProjectInspector } from "./App-inspector.tsx";
import { FILTERS, type Filter, projectStatusVariant } from "./App-shared.ts";
import { formatDueDate, statusLabel } from "./model.ts";

export function App() {
	const data = useProjectsData();
	const actions = useProjectActions(data);
	const guidance = useProjectGuidance(data);
	const {
		error,
		filter,
		loading,
		mode,
		project,
		setError,
		setFilter,
		setSelectedId,
		state,
		stats,
		visibleProjects,
	} = data;
	const { setNewOpen } = actions;

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
						<ProjectDetail
							actions={actions}
							data={data}
							project={project}
							state={state}
						/>
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
						<ProjectInspector
							actions={actions}
							data={data}
							guidance={guidance}
							project={project}
						/>
					) : null}
				</div>
			</RyuAppMain>

			<NewProjectDialog actions={actions} />
			<PromptEditDialog guidance={guidance} />
		</div>
	);
}
