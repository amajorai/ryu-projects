import path from "node:path";
import { defineConfig } from "@playwright/test";

const appRoot = path.resolve(import.meta.dirname, "..");
const baseURL = "http://127.0.0.1:49371";

export default defineConfig({
	fullyParallel: false,
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	reporter: "list",
	retries: 0,
	testDir: import.meta.dirname,
	testMatch: "projects-companion.spec.ts",
	timeout: 30_000,
	use: {
		baseURL,
		headless: true,
		viewport: { height: 1000, width: 1440 },
	},
	webServer: {
		command:
			"bun run build && bun run vite preview --host 127.0.0.1 --port 49371 --strictPort",
		cwd: appRoot,
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
