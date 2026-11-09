import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { ProjectActions } from "./App-actions.ts";
import type { ProjectsData } from "./App-data.ts";
import type { ProjectGuidance } from "./App-guidance.ts";

/** Model defaults, workers and subscriptions for the selected project. */
export function ProjectInspectorOperations({
	actions,
	data,
	guidance,
}: {
	actions: ProjectActions;
	data: ProjectsData;
	guidance: ProjectGuidance;
}) {
	const { mode, subscriptions, workers } = data;
	const {
		addProjectSubscription,
		addProjectWorker,
		setSubscriptionKind,
		setSubscriptionName,
		setSubscriptionSchedule,
		setWorkerTask,
		setWorkerTitle,
		subscriptionKind,
		subscriptionName,
		subscriptionSchedule,
		workerTask,
		workerTitle,
	} = actions;
	const { defaultsDraft, saveProjectDefaults, setDefaultsDraft } = guidance;
	return (
		<>
			<div className="projects-inspector-block">
				<div className="projects-section-heading">
					<div>
						<h3>Model defaults</h3>
						<p className="projects-muted">
							Every thread in this project uses these unless a bot or session
							overrides them. Leave empty to use the node default.
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
						<NativeSelectOption value="">Inherit effort</NativeSelectOption>
						<NativeSelectOption value="low">Low</NativeSelectOption>
						<NativeSelectOption value="medium">Medium</NativeSelectOption>
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
						onChange={(event) => setSubscriptionName(event.target.value)}
						placeholder="Subscription name"
						value={subscriptionName}
					/>
					<NativeSelect
						aria-label="Subscription kind"
						onChange={(event) => setSubscriptionKind(event.target.value)}
						value={subscriptionKind}
					>
						<NativeSelectOption value="schedule">Schedule</NativeSelectOption>
						<NativeSelectOption value="slack">Slack webhook</NativeSelectOption>
						<NativeSelectOption value="pull_request">
							Pull request webhook
						</NativeSelectOption>
					</NativeSelect>
					{subscriptionKind === "schedule" ? (
						<Input
							aria-label="Subscription interval"
							onChange={(event) => setSubscriptionSchedule(event.target.value)}
							placeholder="1h"
							value={subscriptionSchedule}
						/>
					) : null}
					<Button size="xs" type="submit">
						Arm subscription
					</Button>
				</form>
				{subscriptions.slice(0, 3).map((subscription) => (
					<div className="projects-worker" key={String(subscription.id)}>
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
					{mode === "live" ? "Node-owned + Spaces context" : "Preview data"}
				</Badge>
			</RyuAppActions>
		</>
	);
}
