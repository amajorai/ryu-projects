import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	namedAssertionIsPresent,
	reconcileLocalInteractionMap,
} from "../../../../apps-store/companion-suite.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
const inventoryPath = resolve(
	repositoryRoot,
	"docs/proof/test-coverage-sweep-20260924/companion-interaction-inventory.tsv"
);
const mapPath = resolve(import.meta.dirname, "companion-interactions.json");
const specPath = resolve(import.meta.dirname, "projects-companion.spec.ts");

function parseTsv(source) {
	const [headerLine, ...lines] = source.trimEnd().split("\n");
	const headers = headerLine?.split("\t") ?? [];
	return lines.map((line) => {
		const values = line.split("\t");
		return Object.fromEntries(
			headers.map((header, index) => [header, values[index] ?? ""])
		);
	});
}

const censusRows = parseTsv(readFileSync(inventoryPath, "utf8"));
const map = JSON.parse(readFileSync(mapPath, "utf8"));
const specSource = readFileSync(specPath, "utf8");

describe("Projects package-owned interaction map", () => {
	test("joins all mapped assertions to exact live census identities and named UI tests", () => {
		const reconciled = reconcileLocalInteractionMap(
			"projects",
			censusRows,
			map
		);
		expect(reconciled).toHaveLength(47);
		for (const { assertion } of reconciled) {
			expect(
				namedAssertionIsPresent(
					specSource,
					assertion.testTitle,
					assertion.assertionMarker
				)
			).toBe(true);
		}
	});

	test("rejects duplicate, stale, ambiguous, and incomplete identities", () => {
		const first = map.assertions[0];
		expect(first).toBeDefined();
		const duplicate = { ...first };
		expect(() =>
			reconcileLocalInteractionMap("projects", censusRows, {
				...map,
				assertions: [first, duplicate],
				expectedRows: 2,
				scope: "partial",
			})
		).toThrow("duplicates an interaction identity");

		const stale = {
			...first,
			row: { ...first.row, line: "99999" },
		};
		expect(() =>
			reconcileLocalInteractionMap("projects", censusRows, {
				...map,
				assertions: [stale],
				expectedRows: 1,
				scope: "partial",
			})
		).toThrow("does not match exactly one current central census row");

		const projectRows = censusRows.filter((row) => row.package === "projects");
		expect(() =>
			reconcileLocalInteractionMap(
				"projects",
				[...censusRows, { ...projectRows[0] }],
				{ ...map, assertions: [first], expectedRows: 1, scope: "partial" }
			)
		).toThrow("central census contains duplicate interaction identity");

		expect(() =>
			reconcileLocalInteractionMap("projects", censusRows, {
				...map,
				assertions: map.assertions.slice(0, -1),
			})
		).toThrow("expected 47 rows but contains 46");
	});

	test("keeps assertion markers in the named test body rather than a neighboring test", () => {
		const source = `test("first flow", async () => {
			await expect(page.getByRole("button", { name: "Create project" })).toBeVisible();
		});

		test("second flow", async () => {
			await expect(page.getByRole("textbox", { name: "Project owner" })).toBeVisible();
		});`;
		expect(
			namedAssertionIsPresent(source, "first flow", "Create project")
		).toBe(true);
		expect(namedAssertionIsPresent(source, "first flow", "Project owner")).toBe(
			false
		);
	});
});
