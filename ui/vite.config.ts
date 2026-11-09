import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
	plugins: [react(), viteSingleFile()],
	build: {
		// esbuild 0.28 cannot lower destructuring for Vite 6's default browser floor
		// (safari14 and friends); the Companion webviews all run modern engines.
		target: "esnext",
		cssCodeSplit: false,
		assetsInlineLimit: 1_000_000,
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
