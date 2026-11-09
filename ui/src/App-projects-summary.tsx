import { useRichLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";

const bold = { b: (chunks: ReactNode) => <strong>{chunks}</strong> };

/**
 * The Projects header counters. Each counter is one whole message with the number
 * inside it, so a language can inflect the noun for the count ("1 человек",
 * "3 человека") and place the number where its grammar wants.
 */
export function ProjectsSummaryCounts({
	active,
	openTasks,
	total,
}: {
	active: number;
	openTasks: number;
	total: number;
}) {
	const tlRich = useRichLiteralMessages();
	return (
		<>
			<span>
				{tlRich(
					"{count, plural, one {<b>#</b> project} other {<b>#</b> projects}}",
					{ count: total },
					bold
				)}
			</span>
			<span>
				{tlRich(
					"{count, plural, one {<b>#</b> active} other {<b>#</b> active}}",
					{ count: active },
					bold
				)}
			</span>
			<span>
				{tlRich(
					"{count, plural, one {<b>#</b> open task} other {<b>#</b> open tasks}}",
					{ count: openTasks },
					bold
				)}
			</span>
		</>
	);
}
