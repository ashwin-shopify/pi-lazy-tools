/**
 * Lazy Tools Extension
 *
 * Reduces context window usage by loading tool groups on demand instead of
 * all at once. On first run, presents a setup wizard to choose which groups
 * are always active vs lazy-loaded. The LLM can load groups mid-session via
 * the `load_tools` gateway tool.
 *
 * Config: ~/.pi/agent/lazy-tools.json
 *
 * Commands:
 *   /tools-setup  — Re-run the setup wizard to change preferences
 *   /tools-load   — Quickly load a tool group for this session
 *   /tools-status  — Show current tool group status
 *
 * Shortcut:
 *   Ctrl+Shift+T  — Cycle through and toggle tool groups
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type GroupMode,
	type LazyToolsConfig,
	type ToolGroup,
	categorizeTools,
	computeActiveTools,
	getGroupMode,
	getLoadableGroups,
	loadGroups,
	loadConfigFromPath,
	saveConfigToPath,
	buildDefaultConfig,
	buildLazyGroupsPrompt,
} from "./lib.js";

function getConfigPath(): string {
	return join(getAgentDir(), "lazy-tools.json");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function lazyToolsExtension(pi: ExtensionAPI) {
	let toolGroups: ToolGroup[] = [];
	let config: LazyToolsConfig | null = null;
	/** Groups activated this session (on-demand that were loaded) */
	let sessionActivated = new Set<string>();
	let isEnabled = true;

	// ── Helpers ────────────────────────────────────────────────────────────

	function activeToolNames(): string[] {
		return computeActiveTools(toolGroups, config, sessionActivated);
	}

	function applyActiveTools(): void {
		if (!isEnabled) return;
		pi.setActiveTools(activeToolNames());
	}

	function loadableGroups(): ToolGroup[] {
		return getLoadableGroups(toolGroups, config, sessionActivated);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const activeCount = activeToolNames().length - 1; // Subtract load_tools
		const totalCount = toolGroups.reduce((sum, g) => sum + g.tools.length, 0);
		const onDemandGroups = loadableGroups();

		if (!isEnabled || activeCount === totalCount) {
			ctx.ui.setStatus("lazy-tools", undefined);
		} else {
			const label = onDemandGroups.length > 0
				? `⚡ ${activeCount}/${totalCount} tools (${onDemandGroups.length} groups on-demand)`
				: `⚡ ${activeCount}/${totalCount} tools`;
			ctx.ui.setStatus("lazy-tools", label);
		}
	}

	// ── Register --lazy flag ──────────────────────────────────────────────

	pi.registerFlag("lazy", {
		description: "Enable lazy tool loading (default: true if config exists)",
		type: "boolean",
	});

	// ── Gateway Tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "load_tools",
		label: "Load Tools",
		description:
			"Load a tool group on demand. Call this before using tools from an inactive group. " +
			"Available groups are listed in the system prompt under 'Lazy-loadable tool groups'.",
		promptSnippet: "Load a tool group on demand (observe, vault, slack, etc.) to access its tools",
		promptGuidelines: [
			"Before using a tool that isn't active, call load_tools to activate its group.",
			"Check the 'Lazy-loadable tool groups' section in the system prompt to see which groups are available.",
			"You can load multiple groups at once by passing an array of group names.",
		],
		parameters: Type.Object({
			groups: Type.Array(Type.String({ description: "Group names to load (e.g. 'observe', 'vault', 'slack')" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { loaded, alreadyActive, notFound, disabled } = loadGroups(
				params.groups, toolGroups, config, sessionActivated,
			);

			applyActiveTools();
			updateStatus(ctx);

			const parts: string[] = [];
			if (loaded.length > 0) {
				const details = loaded.map((name) => {
					const group = toolGroups.find((g) => g.name === name)!;
					return `${group.displayName} (${group.tools.length} tools: ${group.tools.join(", ")})`;
				});
				parts.push(`Loaded: ${details.join("; ")}`);
			}
			if (alreadyActive.length > 0) parts.push(`Already active: ${alreadyActive.join(", ")}`);
			if (notFound.length > 0) parts.push(`Not found: ${notFound.join(", ")}`);
			if (disabled.length > 0) parts.push(`Disabled by user: ${disabled.join(", ")}`);

			// Persist loaded state to session
			pi.appendEntry("lazy-tools-session", { activated: Array.from(sessionActivated) });

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { loaded, alreadyActive, notFound, disabled },
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as { loaded: string[]; alreadyActive: string[]; notFound: string[]; disabled: string[] } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const parts: string[] = [];
			if (details.loaded?.length > 0) {
				parts.push(theme.fg("success", `✓ Loaded: ${details.loaded.join(", ")}`));
			}
			if (details.alreadyActive?.length > 0) {
				parts.push(theme.fg("muted", `Already active: ${details.alreadyActive.join(", ")}`));
			}
			if (details.notFound?.length > 0) {
				parts.push(theme.fg("warning", `Not found: ${details.notFound.join(", ")}`));
			}
			if (details.disabled?.length > 0) {
				parts.push(theme.fg("warning", `Disabled: ${details.disabled.join(", ")}`));
			}
			return new Text(parts.join("\n") || "No changes", 0, 0);
		},
	});

	// ── Setup Wizard ──────────────────────────────────────────────────────

	async function runSetupWizard(ctx: ExtensionContext): Promise<boolean> {
		// Build SettingsList items for each group
		const items: SettingItem[] = toolGroups.map((group) => ({
			id: group.name,
			label: `${group.displayName} (${group.tools.length} tools)`,
			currentValue: group.name === "core" ? "always" : (config?.groups[group.name] ?? "on-demand"),
			values: group.name === "core" ? ["always"] : ["always", "on-demand", "off"],
		}));

		const newConfig: Record<string, GroupMode> = {};

		// Initialize from current config
		for (const group of toolGroups) {
			newConfig[group.name] = getGroupMode(config, group.name);
		}

		const result = await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
			const container = new Container();

			// Title
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new (class {
					render(_width: number) {
						return [
							" " + theme.fg("accent", theme.bold("⚡ Lazy Tools Setup")),
							"",
							" " + theme.fg("dim", "Configure which tool groups load at startup vs on-demand."),
							" " + theme.fg("dim", "always    → loaded at session start (uses context tokens)"),
							" " + theme.fg("dim", "on-demand → loaded when needed by LLM or /tools-load"),
							" " + theme.fg("dim", "off       → never loaded"),
							"",
						];
					}
					invalidate() {}
				})(),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 18),
				getSettingsListTheme(),
				(id, newValue) => {
					newConfig[id] = newValue as GroupMode;
				},
				() => {
					// Save on close
					config = { version: 1, groups: newConfig };
					saveConfigToPath(getConfigPath(), config);
					done(true);
				},
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			// Help text
			container.addChild(
				new (class {
					render(_width: number) {
						return [
							"",
							" " + theme.fg("dim", "← → change mode • ↑ ↓ navigate • / search • esc save & close"),
						];
					}
					invalidate() {}
				})(),
			);

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => settingsList.handleInput?.(data),
			};
		});

		return result ?? false;
	}

	// ── Quick Load Command ────────────────────────────────────────────────

	async function showQuickLoader(ctx: ExtensionContext): Promise<void> {
		const loadable = loadableGroups();
		if (loadable.length === 0) {
			ctx.ui.notify("All tool groups are already active", "info");
			return;
		}

		const items: SelectItem[] = loadable.map((group) => ({
			value: group.name,
			label: `${group.displayName} (${group.tools.length} tools)`,
			description: group.description,
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(" " + theme.fg("accent", theme.bold("⚡ Load Tool Group")), 1, 0));
			container.addChild(new Text("", 0, 0));

			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item: SelectItem) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(" " + theme.fg("dim", "↑↓ navigate • enter load • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (result) {
			sessionActivated.add(result);
			applyActiveTools();
			updateStatus(ctx);
			pi.appendEntry("lazy-tools-session", { activated: Array.from(sessionActivated) });
			const group = toolGroups.find((g) => g.name === result)!;
			ctx.ui.notify(`Loaded ${group.displayName} (${group.tools.length} tools)`, "success");
		}
	}

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("tools-setup", {
		description: "Configure which tool groups are always-on vs lazy-loaded",
		handler: async (_args, ctx) => {
			toolGroups = categorizeTools(pi.getAllTools());
			await runSetupWizard(ctx);
			sessionActivated.clear();
			applyActiveTools();
			updateStatus(ctx);
			ctx.ui.notify("Tool configuration saved", "success");
		},
	});

	pi.registerCommand("tools-load", {
		description: "Load an on-demand tool group for this session",
		handler: async (args, ctx) => {
			if (args?.trim()) {
				// Direct load by name
				const name = args.trim();
				const group = toolGroups.find((g) => g.name === name);
				if (!group) {
					ctx.ui.notify(`Unknown group: ${name}`, "error");
					return;
				}
				sessionActivated.add(name);
				applyActiveTools();
				updateStatus(ctx);
				pi.appendEntry("lazy-tools-session", { activated: Array.from(sessionActivated) });
				ctx.ui.notify(`Loaded ${group.displayName} (${group.tools.length} tools)`, "success");
				return;
			}
			await showQuickLoader(ctx);
		},
		completer: (prefix) => {
			const loadable = loadableGroups();
			const items = loadable.map((g) => ({ value: g.name, label: g.name }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
	});

	pi.registerCommand("tools-status", {
		description: "Show current tool group status",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			for (const group of toolGroups) {
				const mode = getGroupMode(config, group.name);
				const loaded = sessionActivated.has(group.name);
				const icon = mode === "always" || loaded ? "●" : mode === "on-demand" ? "○" : "✕";
				const status = mode === "always"
					? "always"
					: loaded
						? "loaded this session"
						: mode === "on-demand"
							? "on-demand"
							: "off";
				lines.push(`${icon} ${group.displayName} (${group.tools.length}) — ${status}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Shortcut to quick-load
	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Quick-load a tool group",
		handler: async (ctx) => {
			await showQuickLoader(ctx);
		},
	});

	// ── System Prompt Injection ───────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!isEnabled) return;

		const loadable = loadableGroups();
		if (loadable.length === 0) return;

		const injection = buildLazyGroupsPrompt(loadable);
		if (!injection) return;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// ── Session Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		// Discover tool groups from everything that's registered
		toolGroups = categorizeTools(pi.getAllTools());

		// Check --lazy flag
		const lazyFlag = pi.getFlag("lazy");
		if (lazyFlag === false) {
			isEnabled = false;
			ctx.ui.setStatus("lazy-tools", undefined);
			return;
		}

		// Load config
		config = loadConfigFromPath(getConfigPath());

		// Restore session-activated groups from branch
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "lazy-tools-session") {
				const data = entry.data as { activated?: string[] } | undefined;
				if (data?.activated) {
					sessionActivated = new Set(data.activated);
				}
			}
		}

		// First-time setup
		if (!config && event.reason === "startup" && ctx.hasUI) {
			const proceed = await ctx.ui.confirm(
				"⚡ Lazy Tools",
				"No lazy-tools config found. Run setup wizard to choose which tool groups load on-demand?",
				{ timeout: 10000 },
			);

			if (proceed) {
				await runSetupWizard(ctx);
			} else {
				config = buildDefaultConfig(toolGroups);
				saveConfigToPath(getConfigPath(), config);
				ctx.ui.notify("Default config saved: core always-on, everything else on-demand. Use /tools-setup to change.", "info");
			}
		}

		if (config) {
			applyActiveTools();
		}
		updateStatus(ctx);
	});

	// Restore on tree navigation
	pi.on("session_tree", async (_event, ctx) => {
		sessionActivated.clear();
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "lazy-tools-session") {
				const data = entry.data as { activated?: string[] } | undefined;
				if (data?.activated) {
					sessionActivated = new Set(data.activated);
				}
			}
		}
		applyActiveTools();
		updateStatus(ctx);
	});
}
