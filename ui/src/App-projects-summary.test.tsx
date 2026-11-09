import { afterEach, describe, expect, test } from "bun:test";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectsSummaryCounts } from "./App-projects-summary.tsx";

const COUNTER =
	"{count, plural, one {<b>#</b> project} other {<b>#</b> projects}}";

function render(locale: string, count: number): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
		>
			<ProjectsSummaryCounts active={count} openTasks={count} total={count} />
		</I18nProvider>
	);
}

afterEach(() => registerLiteralCatalogLoader(null));

describe("ProjectsSummaryCounts", () => {
	test("keeps each number inside its counter in English", () => {
		expect(render("en", 1)).toContain("<strong>1</strong> project<");
		const html = render("en", 2);
		expect(html).toContain("<strong>2</strong> projects");
		expect(html).toContain("<strong>2</strong> open tasks");
	});

	test("lets Russian pick the plural form for the count", () => {
		registerLiteralCatalogLoader(() => ({
			[COUNTER]:
				"{count, plural, one {<b>#</b> проект} few {<b>#</b> проекта} other {<b>#</b> проектов}}",
		}));
		expect(render("ru", 3)).toContain("<strong>3</strong> проекта");
		expect(render("ru", 5)).toContain("<strong>5</strong> проектов");
	});
});
