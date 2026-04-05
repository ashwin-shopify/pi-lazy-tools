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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolGroup {
	name: string;
	displayName: string;
	tools: string[];
	description: string;
}

type GroupMode = "always" | "on-demand" | "off";

interface LazyToolsConfig {
	version: 1;
	/** Map of group name → mode */
	groups: Record<string, GroupMode>;
}

// ─── Tool Group Definitions ──────────────────────────────────────────────────

/** Categorize tools into groups by prefix. Unknown tools go into "core". */
function categorizeTools(allTools: ToolInfo[]): ToolGroup[] {
	const prefixMap: Record<string, { displayName: string; description: string }> = {
		observe: { displayName: "Observe", description: "Observability: logs, metrics, traces, error groups, dashboards" },
		vault: { displayName: "Vault", description: "Shopify internal: people, teams, projects, missions, pages, issues" },
		bk: { displayName: "Buildkite", description: "CI/CD: builds, jobs, pipelines, failure triage" },
		slack: { displayName: "Slack", description: "Messaging: search, threads, channels, DMs, canvases" },
		gcal: { displayName: "Google Calendar", description: "Calendar: events, availability, scheduling" },
		gmail: { displayName: "Gmail", description: "Email: search, read, manage messages" },
		gdoc: { displayName: "Google Docs", description: "Docs: create, write, edit documents" },
		gdrive: { displayName: "Google Drive", description: "Drive: search files" },
		gworkspace: { displayName: "Google Workspace", description: "Workspace: file metadata, read Drive files" },
		grokt: { displayName: "Grokt", description: "Code search: regex search across all indexed repos" },
		data_portal: { displayName: "Data Portal", description: "BigQuery: search tables, run SQL, create dashboards" },
		memory: { displayName: "Memory", description: "Persistent memory bank: read, write, search knowledge" },
		superpowers: { displayName: "Superpowers", description: "Skills and subagent dispatch" },
	};

	const groups = new Map<string, string[]>();
	const coreTools: string[] = [];

	for (const tool of allTools) {
		let matched = false;
		for (const prefix of Object.keys(prefixMap)) {
			if (tool.name.startsWith(prefix + "_") || tool.name.startsWith(prefix + ".") || tool.name === prefix) {
				const existing = groups.get(prefix) ?? [];
				existing.push(tool.name);
				groups.set(prefix, existing);
				matched = true;
				break;
			}
		}
		if (!matched) {
			coreTools.push(tool.name);
		}
	}

	const result: ToolGroup[] = [];

	// Core always first
	if (coreTools.length > 0) {
		result.push({
			name: "core",
			displayName: "Core",
			tools: coreTools,
			description: "Essential tools: read, write, edit, bash, ask, set_session_label, etc.",
		});
	}

	// Then discovered groups, sorted by tool count descending
	const sortedPrefixes = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
	for (const [prefix, tools] of sortedPrefixes) {
		const meta = prefixMap[prefix]!;
		result.push({
			name: prefix,
			displayName: meta.displayName,
			tools,
			description: meta.description,
		});
	}

	return result;
}

// ─── Config Persistence ──────────────────────────────────────────────────────

function getConfigPath(): string {
	return join(getAgentDir(), "lazy-tools.json");
}

function loadConfig(): LazyToolsConfig | null {
	const path = getConfigPath();
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as LazyToolsConfig;
	} catch {
		return null;
	}
}

function saveConfig(config: LazyToolsConfig): void {
	const path = getConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function lazyToolsExtension(pi: ExtensionAPI) {
	let toolGroups: ToolGroup[] = [];
	let config: LazyToolsConfig | null = null;
	/** Groups activated this session (on-demand that were loaded) */
	let sessionActivated = new Set<string>();
	let isEnabled = true;

	// ── Helpers ────────────────────────────────────────────────────────────

	function getGroupMode(groupName: string): GroupMode {
		if (!config) return "always";
		// Core is always "always"
		if (groupName === "core") return "always";
		return config.groups[groupName] ?? "on-demand";
	}

	function getActiveToolNames(): string[] {
		const tools: string[] = [];
		for (const group of toolGroups) {
			const mode = getGroupMode(group.name);
			if (mode === "always" || sessionActivated.has(group.name)) {
				tools.push(...group.tools);
			}
		}
		// Always include the load_tools gateway
		if (!tools.includes("load_tools")) {
			tools.push("load_tools");
		}
		return tools;
	}

	function applyActiveTools(): void {
		if (!isEnabled) return;
		pi.setActiveTools(getActiveToolNames());
	}

	function getLoadableGroups(): ToolGroup[] {
		return toolGroups.filter((g) => {
			const mode = getGroupMode(g.name);
			return mode === "on-demand" && !sessionActivated.has(g.name);
		});
	}

	function formatGroupLabel(group: ToolGroup): string {
		const mode = getGroupMode(group.name);
		const loaded = sessionActivated.has(group.name);
		const suffix = mode === "on-demand" && loaded ? " (loaded)" : "";
		return `${group.displayName} (${group.tools.length} tools)${suffix}`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const activeCount = getActiveToolNames().length - 1; // Subtract load_tools
		const totalCount = toolGroups.reduce((sum, g) => sum + g.tools.length, 0);
		const onDemandGroups = getLoadableGroups();

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
			const loaded: string[] = [];
			const alreadyActive: string[] = [];
			const notFound: string[] = [];
			const disabled: string[] = [];

			for (const name of params.groups) {
				const group = toolGroups.find((g) => g.name === name);
				if (!group) {
					notFound.push(name);
					continue;
				}
				const mode = getGroupMode(name);
				if (mode === "off") {
					disabled.push(name);
					continue;
				}
				if (mode === "always" || sessionActivated.has(name)) {
					alreadyActive.push(name);
					continue;
				}
				sessionActivated.add(name);
				loaded.push(name);
			}

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
			const details = result.details as { loaded: string[]; alreadyActive: string[] };
			const lines: string[] = [];
			if (details?.loaded?.length > 0) {
				lines.push(theme.fg("success", `✓ Loaded: ${details.loaded.join(", ")}`));
			}
			if (details?.alreadyActive?.length > 0) {
				lines.push(theme.fg("muted", `Already active: ${details.alreadyActive.join(", ")}`));
			}
			return lines.length > 0 ? lines : undefined;
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
			newConfig[group.name] = getGroupMode(group.name);
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
					saveConfig(config);
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
		const loadable = getLoadableGroups();
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
			const loadable = getLoadableGroups();
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
				const mode = getGroupMode(group.name);
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

		const loadable = getLoadableGroups();
		if (loadable.length === 0) return;

		const groupList = loadable
			.map((g) => `- ${g.name}: ${g.description} (${g.tools.length} tools)`)
			.join("\n");

		const injection = `
## Lazy-loadable tool groups

The following tool groups are available but NOT currently loaded. Call load_tools(groups: ["<name>"]) to activate them before using any of their tools.

${groupList}

Do NOT hallucinate tools from inactive groups. Call load_tools first.`;

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
		config = loadConfig();

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
				// Default: core + memory always, everything else on-demand
				const defaultGroups: Record<string, GroupMode> = {};
				for (const group of toolGroups) {
					defaultGroups[group.name] = group.name === "core" || group.name === "memory" ? "always" : "on-demand";
				}
				config = { version: 1, groups: defaultGroups };
				saveConfig(config);
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
