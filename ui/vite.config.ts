import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
	plugins: [react(), viteSingleFile()],
	build: {
		cssCodeSplit: false,
		assetsInlineLimit: 1_000_000,
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
