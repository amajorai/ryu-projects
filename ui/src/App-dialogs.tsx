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
import type { ProjectActions } from "./App-actions.ts";
import type { ProjectGuidance } from "./App-guidance.ts";
import type { ExecutionMode } from "./types.ts";

/** The "New project" form dialog. */
export function NewProjectDialog({ actions }: { actions: ProjectActions }) {
	const {
		createNewProject,
		formError,
		newForm,
		newOpen,
		setFormError,
		setNewForm,
		setNewOpen,
	} = actions;
	return (
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
						<p aria-live="polite" className="projects-form-error" role="alert">
							{formError}
						</p>
					) : null}
					<DialogFooter>
						<Button type="submit">Create project</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Confirms a save that resets the prompt cache. */
export function PromptEditDialog({ guidance }: { guidance: ProjectGuidance }) {
	const { pendingPromptEdit, setPendingPromptEdit } = guidance;
	return (
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
					<Button onClick={() => setPendingPromptEdit(null)} variant="outline">
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
	);
}
