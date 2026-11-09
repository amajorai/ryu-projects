import {
	type PromptField,
	pluralField,
} from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ProjectMember } from "./types.ts";

/**
 * Translated labels the prompt-cache confirmation names for a project goal
 * save. Plural nouns are marked, so the verb agrees in every language.
 */
export function projectGoalFields(
	changes: { briefReplies: boolean; goal: boolean },
	tl: LiteralMessage
): PromptField[] {
	const fields: PromptField[] = [];
	if (changes.goal) {
		fields.push(tl("The project goal"));
	}
	if (changes.briefReplies) {
		fields.push(pluralField(tl("Brief replies")));
	}
	return fields;
}

/** The label for a project instructions save (a plural noun). */
export function projectInstructionsField(tl: LiteralMessage): PromptField {
	return pluralField(tl("The project instructions"));
}

/** The label for one bot member's goal inside the project. */
export function memberGoalField(
	member: Pick<ProjectMember, "id" | "name">,
	tl: LiteralMessage
): PromptField {
	return tl("{name}'s goal", { name: member.name || member.id });
}
