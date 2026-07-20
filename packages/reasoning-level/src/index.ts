import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

const STATUS_ARGUMENT = "status";

function modelLabel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function supportedLevels(model: Model<any>): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}

function notifyStatus(pi: ExtensionAPI, ctx: ExtensionContext, model: Model<any>): void {
	ctx.ui.notify(
		[
			`Model: ${modelLabel(model)}`,
			`Current reasoning level: ${pi.getThinkingLevel()}`,
			`Supported levels: ${supportedLevels(model).join(", ")}`,
		].join("\n"),
		"info",
	);
}

export default function reasoningLevelExtension(pi: ExtensionAPI): void {
	let completionLevels: ModelThinkingLevel[] = ["off"];

	function updateCompletionLevels(model: Model<any> | undefined): void {
		completionLevels = model ? supportedLevels(model) : ["off"];
	}

	pi.on("session_start", (_event, ctx) => {
		updateCompletionLevels(ctx.model);
	});

	pi.on("model_select", (event) => {
		updateCompletionLevels(event.model);
	});

	pi.registerCommand("reasoning", {
		description: "Show or change the current model's reasoning level. Usage: /reasoning [status|<level>]",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const candidates = [STATUS_ARGUMENT, ...completionLevels];
			const matches = candidates
				.filter((candidate) => candidate.startsWith(normalizedPrefix))
				.map((candidate) => ({ value: candidate, label: candidate }));

			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is currently selected.", "error");
				return;
			}

			const available = supportedLevels(model);
			updateCompletionLevels(model);

			const requested = args.trim().toLowerCase();
			if (requested === STATUS_ARGUMENT) {
				notifyStatus(pi, ctx, model);
				return;
			}

			if (requested === "") {
				if (!ctx.hasUI) return;

				const selection = await ctx.ui.select(
					`Reasoning for ${modelLabel(model)} (current: ${pi.getThinkingLevel()})`,
					available,
				);
				const selectedLevel = available.find((level) => level === selection);
				if (!selectedLevel) return;

				pi.setThinkingLevel(selectedLevel);
				ctx.ui.notify(`Reasoning level: ${pi.getThinkingLevel()}`, "info");
				return;
			}

			const requestedLevel = available.find((level) => level === requested);
			if (!requestedLevel) {
				ctx.ui.notify(
					`Unsupported reasoning level for ${modelLabel(model)}. Available: ${available.join(", ")}`,
					"error",
				);
				return;
			}

			pi.setThinkingLevel(requestedLevel);
			ctx.ui.notify(`Reasoning level: ${pi.getThinkingLevel()}`, "info");
		},
	});
}
