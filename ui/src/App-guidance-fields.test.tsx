import { afterEach, describe, expect, test } from "bun:test";
import {
	type PromptEditReach,
	type PromptField,
	promptEditCacheWarning,
} from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { formatMessage } from "@ryu/i18n";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import {
	I18nProvider,
	type LiteralMessage,
	useLiteralMessages,
} from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	memberGoalField,
	projectGoalFields,
	projectInstructionsField,
} from "./App-guidance-fields.ts";

const WARNING =
	"{number, select, singular {{list} is part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.} other {{list} are part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.}}";

const DE: Record<string, string> = {
	[WARNING]:
		"{number, select, singular {{list} ist Teil des Systemprompts für {reach}.} other {{list} sind Teil des Systemprompts für {reach}.}}",
	"{name}'s goal": "Ziel von {name}",
	"Brief replies": "Kurze Antworten",
	"The project instructions": "Die Projektanweisungen",
	"every thread in this project": "jeden Thread in diesem Projekt",
	"this bot's threads in this project":
		"die Threads dieses Bots in diesem Projekt",
};

/** Renders the confirmation text a save would show, in `locale`. */
function renderWarning(
	locale: string,
	fields: (tl: LiteralMessage) => PromptField[],
	reach: PromptEditReach
): string {
	function Warning() {
		const tl = useLiteralMessages();
		return <p>{promptEditCacheWarning(fields(tl), reach, tl)?.description}</p>;
	}
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
		>
			<Warning />
		</I18nProvider>
	);
}

afterEach(() => registerLiteralCatalogLoader(null));

describe("project guidance confirmation labels", () => {
	test("a bot member's goal reads as one German message", () => {
		registerLiteralCatalogLoader((locale) => (locale === "de" ? DE : {}));
		const html = renderWarning(
			"de",
			(tl) => [memberGoalField({ id: "agent-1", name: "Scout" }, tl)],
			"bot-in-project"
		);
		expect(html).toContain(
			"Ziel von Scout ist Teil des Systemprompts für die Threads dieses Bots in diesem Projekt."
		);
		expect(html).not.toContain("goal");
	});

	test("an unnamed member falls back to its id", () => {
		const tl: LiteralMessage = (source, values) =>
			formatMessage(source, values ?? {});
		expect(memberGoalField({ id: "agent-1", name: "" }, tl)).toBe(
			"agent-1's goal"
		);
	});

	test("plural labels take the plural verb on their own", () => {
		registerLiteralCatalogLoader((locale) => (locale === "de" ? DE : {}));
		expect(
			renderWarning("de", (tl) => [projectInstructionsField(tl)], "project")
		).toContain(
			"Die Projektanweisungen sind Teil des Systemprompts für jeden Thread in diesem Projekt."
		);
		expect(
			renderWarning(
				"de",
				(tl) => projectGoalFields({ briefReplies: true, goal: false }, tl),
				"project"
			)
		).toContain("Kurze Antworten sind Teil");
	});

	test("only the changed settings are named", () => {
		const tl: LiteralMessage = (source) => source;
		expect(projectGoalFields({ briefReplies: false, goal: false }, tl)).toEqual(
			[]
		);
		expect(projectGoalFields({ briefReplies: false, goal: true }, tl)).toEqual([
			"The project goal",
		]);
	});
});
