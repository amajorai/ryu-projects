import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./tailwind.css";

subscribeCompanionTheme();
const root = document.getElementById("ryu-plugin-root");
if (root) {
	markCompanionAppRoot(root);
	createRoot(root).render(
		<StrictMode>
			<RyuAppShell>
				<App />
			</RyuAppShell>
		</StrictMode>
	);
}
