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
import { Container, getKeybindings, Input, Key, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { completeSimple } from "@mariozechner/pi-ai";
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
	watchForAsyncTools,
	reconcileConfig,
	GroupIndex,
	computeToolHash,
	buildCategorizationPrompt,
	parseCategorizationResponse,
	mergeGroupsIntoConfig,
} from "../lib/lib.js";

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
	/** Pre-computed index for fast prompt→group detection. Rebuilt when toolGroups changes. */
	let groupIndex: GroupIndex = new GroupIndex([]);
	/** Debug logging to /tmp/lazy-tools-debug.log */
	let debugLogging = false;

	function debugLog(line: string): void {
		if (!debugLogging) return;
		try { require("fs").appendFileSync("/tmp/lazy-tools-debug.log",
			`[${new Date().toISOString()}] ${line}\n`); } catch {}
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	function rebuildIndex(): void {
		groupIndex = new GroupIndex(toolGroups);
	}

	function activeToolNames(): string[] {
		return computeActiveTools(toolGroups, config, sessionActivated);
	}

	function applyActiveTools(): void {
		if (!isEnabled) return;
		const names = activeToolNames();
		debugLog(
			`applyActiveTools: ${names.length}/${pi.getAllTools().length} tools\n` +
			`  active: ${names.join(", ")}\n` +
			`  groups: ${toolGroups.map(g => `${g.name}(${g.tools.length})`).join(", ")}\n` +
			`  config.groups: ${config ? Object.entries(config.groups).map(([k,v]) => `${k}=${v}`).join(", ") : "null"}\n` +
			`  sessionActivated: ${[...sessionActivated].join(", ") || "none"}`
		);
		pi.setActiveTools(names);
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

	// ── LLM Categorization ───────────────────────────────────────────────────

	/** Find a model by "provider/id" string. */
	function resolveModel(modelStr: string, ctx: ExtensionContext): any {
		const [provider, id] = modelStr.split("/", 2);
		return ctx.modelRegistry.find(provider, id);
	}

	/**
	 * Run LLM categorization with a specific model.
	 * Returns the parsed groups or null on failure.
	 */
	async function categorizationWithModel(model: any, ctx: ExtensionContext): Promise<ToolGroup[] | null> {
		const allTools = pi.getAllTools();
		const prompt = buildCategorizationPrompt(allTools);
		const allToolNames = allTools.map((t) => t.name);

		try {
			const { apiKey, headers } = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const response = await completeSimple(
				model,
				{
					systemPrompt: prompt,
					messages: [{
						role: "user" as const,
						content: [{ type: "text" as const, text: "Categorize these tools." }],
						timestamp: Date.now(),
					}],
				},
				{ maxTokens: 4096, apiKey, headers },
			);

			const text = response.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

			const result = parseCategorizationResponse(text, allToolNames);
			if (!result) {
				ctx.ui.notify(`LLM returned unparseable response (${text.length} chars)`, "warning");
			}
			return result;
		} catch (err: any) {
			ctx.ui.notify(`LLM call failed: ${err?.message ?? err}`, "error");
			return null;
		}
	}

	/**
	 * Run LLM categorization using the model saved in config.
	 * If tool hash matches config, uses cached groups. Otherwise re-runs LLM.
	 * Updates toolGroups, config, and status.
	 */
	async function runLlmCategorization(ctx: ExtensionContext): Promise<boolean> {
		if (!config?.categorizationModel) return false;

		const allTools = pi.getAllTools();
		const currentHash = computeToolHash(allTools);

		// Cache hit: tool set unchanged, use stored groups
		if (config.toolHash === currentHash && config.toolGroups) {
			toolGroups = config.toolGroups;
			rebuildIndex();
			applyActiveTools();
			updateStatus(ctx);
			return true;
		}

		// Cache miss: tools changed, re-run LLM
		const model = resolveModel(config.categorizationModel, ctx);
		if (!model) return false;

		const toolCount = allTools.length;
		ctx.ui.setStatus("lazy-tools", `⚡ Recategorizing ${toolCount} tools...`);

		const parsed = await categorizationWithModel(model, ctx);
		if (parsed) {
			toolGroups = parsed;
			rebuildIndex();
			config = mergeGroupsIntoConfig(config, parsed, currentHash);
			saveConfigToPath(getConfigPath(), config);
			applyActiveTools();
			ctx.ui.setStatus("lazy-tools", `⚡ Recategorized ${toolCount} tools → ${parsed.length} groups`);
			setTimeout(() => updateStatus(ctx), 2000);
			return true;
		}

		ctx.ui.notify("lazy-tools: LLM recategorization failed, using previous groups", "warning");
		updateStatus(ctx);
		return false;
	}

	// ── Smart Pre-hook: LLM-assisted group detection ──────────────────────

	/**
	 * Two-stage pre-hook detection:
	 * 1. Fast gate: keyword/URL matching via GroupIndex (zero-cost if no match)
	 * 2. Smart pick: if gate triggers, call the cheap categorization LLM to
	 *    decide exactly which groups to activate (catches related groups
	 *    like gworkspace for a Google Docs URL)
	 * Falls back to keyword-only results if LLM is unavailable or fails.
	 */
	async function smartDetectGroups(
		prompt: string,
		loadable: ToolGroup[],
		ctx: ExtensionContext,
	): Promise<string[]> {
		const loadableNames = new Set(loadable.map(g => g.name));

		// Stage 1: fast gate — keyword match OR URL present
		const keywordHits = groupIndex.detect(prompt, loadableNames);
		const hasUrl = GroupIndex.hasUrl(prompt);
		debugLog(`smartDetect gate: prompt=${JSON.stringify(prompt.slice(0, 200))} loadable=[${[...loadableNames].join(",")}] keywordHits=[${keywordHits.join(",")}] hasUrl=${hasUrl}`);
		if (keywordHits.length === 0 && !hasUrl) return [];

		// Stage 2: LLM picks from ALL loadable groups (not just keyword hits)
		const modelStr = config?.categorizationModel;
		if (!modelStr) return keywordHits; // no model configured, use keyword results

		const model = resolveModel(modelStr, ctx);
		if (!model) return keywordHits;

		const groupList = loadable
			.map(g => `- ${g.name}: ${g.displayName} (${g.tools.join(", ")})`)
			.join("\n");

		const llmPrompt = [
			"Given this user message, which tool groups should be activated?",
			"Include ALL groups needed to fulfill the request, including groups for reading/accessing content (not just editing).",
			"For example, reading a Google Doc needs both the docs tools AND workspace/drive tools for file access.",
			"Return ONLY a JSON array of group names. No explanation.",
			"",
			"Available groups:",
			groupList,
			"",
			"User message:",
			prompt.slice(0, 500),
		].join("\n");

		try {
			const { apiKey, headers } = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a tool group selector. Return only a JSON array.",
					messages: [{
						role: "user" as const,
						content: [{ type: "text" as const, text: llmPrompt }],
						timestamp: Date.now(),
					}],
				},
				{ maxTokens: 256, apiKey, headers },
			);
			const text = response.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

			debugLog(`smartDetect: keywordHits=${keywordHits.join(",")} model=${modelStr} response=${JSON.stringify(response).slice(0, 500)}`);

			// Parse JSON array from response (handle markdown fences)
			const jsonMatch = text.match(/\[([^\]]*)]/);
			if (jsonMatch) {
				const parsed: string[] = JSON.parse(`[${jsonMatch[1]}]`);
				const valid = parsed.filter(name => loadableNames.has(name));
				if (valid.length > 0) return valid;
			}
		} catch (err: any) {
			// LLM failed — fall through to keyword results
			debugLog(`smartDetect ERROR: ${err?.message ?? err}`);
		}

		return keywordHits;
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
		promptSnippet: "Load a tool group on demand. Available groups are listed in the system prompt under 'Lazy-loadable tool groups'.",
		promptGuidelines: [
			"Before using a tool that isn't active, call load_tools to activate its group.",
			"Check the 'Lazy-loadable tool groups' section in the system prompt to see which groups are available.",
			"You can load multiple groups at once by passing an array of group names.",
			"After calling load_tools, the loaded tools become available on your NEXT response. Do not call loaded tools in the same response as the load_tools call — call load_tools first, then use the tools in your follow-up.",
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
				parts.push("These tools are now available. Proceed to use them.");
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

	async function runSetupWizard(ctx: ExtensionContext, opts?: { firstTime?: boolean }): Promise<boolean> {
		// ── First-time: pick a model and run LLM categorization ──
		if (opts?.firstTime) {
			const available = ctx.modelRegistry.getAvailable();
			if (available.length > 0) {
				const selectItems: SelectItem[] = available.map((m: any) => ({
					label: `${m.provider}/${m.id}`,
					value: `${m.provider}/${m.id}`,
				}));

				// Loop: pick model → try categorization → retry on failure
				let categorized = false;
				while (!categorized) {
					const selectedModel = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(" " + theme.fg("accent", theme.bold("⚡ Pick a fast/cheap LLM")), 1, 0));
						container.addChild(new Text(" " + theme.fg("dim", "Used for: (1) one-time tool grouping at setup, and"), 1, 0));
						container.addChild(new Text(" " + theme.fg("dim", "(2) per-message smart tool detection when keywords match."), 1, 0));
						container.addChild(new Text(" " + theme.fg("dim", "Pick something fast and cheap (e.g. flash, haiku, mini)."), 1, 0));
						container.addChild(new Text("", 0, 0));

						// Filter input
						const filterInput = new Input();
						filterInput.focused = true;
						container.addChild(filterInput);
						container.addChild(new Text("", 0, 0));

						const listTheme = {
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("muted", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t),
						};
						let currentFiltered = selectItems;
						let selectList = new SelectList(currentFiltered, 10, listTheme);
						selectList.onSelect = (item: SelectItem) => done(item.value);
						selectList.onCancel = () => done(null);

						// Wrapper so we can swap out the SelectList on filter change
						const listWrapper: any = {
							render: (w: number) => selectList.render(w),
							invalidate: () => selectList.invalidate(),
						};
						container.addChild(listWrapper);

						const applyFilter = () => {
							const q = filterInput.getValue().toLowerCase();
							currentFiltered = q
								? selectItems.filter((item) => item.label.toLowerCase().includes(q))
								: selectItems;
							selectList = new SelectList(currentFiltered, 10, listTheme);
							selectList.onSelect = (item: SelectItem) => done(item.value);
							selectList.onCancel = () => done(null);
							listWrapper.render = (w: number) => selectList.render(w);
							listWrapper.invalidate = () => selectList.invalidate();
						};

						container.addChild(new Text("", 0, 0));
						container.addChild(new Text(" " + theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								const kb = getKeybindings();
								if (
									kb.matches(data, "tui.select.up") ||
									kb.matches(data, "tui.select.down") ||
									kb.matches(data, "tui.select.pageUp") ||
									kb.matches(data, "tui.select.pageDown") ||
									kb.matches(data, "tui.select.confirm")
								) {
									selectList.handleInput(data);
								} else if (kb.matches(data, "tui.select.cancel")) {
									// If there's filter text, clear it; otherwise cancel
									if (filterInput.getValue()) {
										filterInput.setValue("");
										applyFilter();
									} else {
										selectList.handleInput(data);
									}
								} else {
									filterInput.handleInput(data);
									applyFilter();
								}
								tui.requestRender();
							},
						};
					});

					if (!selectedModel) break; // User dismissed

					const model = resolveModel(selectedModel, ctx);
					if (!model) {
						ctx.ui.notify(`Could not resolve model: ${selectedModel}`, "error");
						continue;
					}

					const toolCount = pi.getAllTools().length;
					ctx.ui.setStatus("lazy-tools", `⚡ Categorizing ${toolCount} tools with ${selectedModel}...`);

					const parsed = await categorizationWithModel(model, ctx);
					if (parsed) {
						toolGroups = parsed;
						rebuildIndex();
						const toolHash = computeToolHash(pi.getAllTools());
						config = buildDefaultConfig(toolGroups, { model: selectedModel, toolHash });
						ctx.ui.setStatus("lazy-tools", `⚡ ${toolCount} tools → ${parsed.length} groups`);
						categorized = true;
					} else {
						ctx.ui.notify(`Categorization failed with ${selectedModel}. Pick another model.`, "warning");
					}
				}
			}
			// No successful categorization → disable, don't save config.
			// Next boot will show the dialog again.
			if (!config) {
				return false;
			}
		}

		// ── Mode picker ──
		// Enter/Space cycles mode. SettingsList handles everything natively.
		const items: SettingItem[] = toolGroups.map((group) => {
			const isCore = group.name === "core";
			return {
				id: group.name,
				label: `${group.displayName} (${group.tools.length} tools)`,
				description: group.tools.join(", "),
				currentValue: isCore ? "always" : (config?.groups[group.name] ?? "on-demand"),
				values: isCore ? ["always"] : ["always", "on-demand", "off"],
			};
		});

		const newConfig: Record<string, GroupMode> = {};

		// Initialize from current config
		for (const group of toolGroups) {
			newConfig[group.name] = getGroupMode(config, group.name);
		}

		const result = await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new (class {
					render(_width: number) {
						return [
							" " + theme.fg("accent", theme.bold("⚡ Lazy Tools Setup")),
							"",
							" " + theme.fg("dim", "Configure which tool groups load at startup vs on-demand."),
							" " + theme.fg("dim", "Enter/Space to cycle mode. Esc to save & close."),
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
					config = {
						...config,
						version: 1,
						groups: newConfig,
					};
					saveConfigToPath(getConfigPath(), config);
					done(true);
				},
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			container.addChild(
				new (class {
					render(_width: number) {
						return [
							"",
							" " + theme.fg("dim", "enter/space cycle mode • ↑↓ navigate • type to search • esc save & close"),
						];
					}
					invalidate() {}
				})(),
			);

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => settingsList.handleInput(data),
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
			// Use existing LLM-generated groups — don't re-run prefix detection.
			// If no groups exist yet (shouldn't happen), fall back to prefix detection.
			if (toolGroups.length === 0) {
				toolGroups = categorizeTools(pi.getAllTools());
				rebuildIndex();
			}
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

	pi.registerCommand("lazy-tools-logging", {
		description: "Toggle debug logging to /tmp/lazy-tools-debug.log",
		handler: async (_args, ctx) => {
			debugLogging = !debugLogging;
			if (debugLogging) {
				try { require("fs").writeFileSync("/tmp/lazy-tools-debug.log", ""); } catch {}
			}
			ctx.ui.notify(`Debug logging ${debugLogging ? "ON" : "OFF"} → /tmp/lazy-tools-debug.log`, "info");
		},
	});

	// Shortcut to quick-load
	pi.registerShortcut(Key.ctrlShift("l"), {
		description: "Quick-load a tool group",
		handler: async (ctx) => {
			await showQuickLoader(ctx);
		},
	});

	// ── System Prompt Injection ───────────────────────────────────────────

	let hasReconciled = false;

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEnabled) return;

		// Safety net: re-apply filter once before the first API call.
		// Catches tools registered after the watcher stabilized.
		if (!hasReconciled) {
			hasReconciled = true;
			// If config has LLM groups, those are the source of truth — don't overwrite.
			// Only reconcile if we have no LLM groups (shouldn't happen in normal flow).
			if (!config?.toolGroups) {
				const allTools = pi.getAllTools();
				toolGroups = categorizeTools(allTools);
				rebuildIndex();
			}
		}

		// Pre-hook: detect tool groups the user likely needs from their prompt.
		// Two-stage: fast keyword gate (GroupIndex), then LLM smart pick if triggered.
		// Zero cost when no keywords match. LLM catches related groups (e.g. gworkspace for a docs URL).
		if (event.prompt) {
			const loadable = loadableGroups();
			if (loadable.length > 0) {
				const detected = await smartDetectGroups(event.prompt, loadable, ctx);
				for (const name of detected) {
					sessionActivated.add(name);
				}
			}
		}

		// Always re-apply active tools before each agent loop.
		// This ensures tools loaded via load_tools or the pre-hook above
		// are included in the context snapshot for the new loop.
		applyActiveTools();

		debugLog(
			`before_agent_start snapshot:\n` +
			`  active: ${activeToolNames().length}/${pi.getAllTools().length} tools\n` +
			`  sessionActivated: ${[...sessionActivated].join(", ") || "none"}\n` +
			`  loadableGroups: ${loadableGroups().map(g => g.name).join(", ") || "none"}`
		);

		const stillLoadable = loadableGroups();
		if (stillLoadable.length === 0) return;

		const injection = buildLazyGroupsPrompt(stillLoadable);
		if (!injection) return;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// ── Session Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		hasReconciled = false;

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

		if (!config && event.reason === "startup" && ctx.hasUI) {
			// ── First time: model picker → LLM categorization → mode picker ──
			await runSetupWizard(ctx, { firstTime: true });

			if (!config) {
				// Setup failed or was dismissed — disable lazy tools for this session
				isEnabled = false;
				ctx.ui.setStatus("lazy-tools", undefined);
				ctx.ui.notify("lazy-tools: setup incomplete, disabled for this session. Use /tools-setup to configure.", "warning");
				return;
			}
		} else if (config) {
			const currentHash = computeToolHash(pi.getAllTools());

			if (config.toolGroups && config.toolHash === currentHash) {
				// ── Cache hit: tools unchanged, use stored groups ──
				toolGroups = config.toolGroups;
				rebuildIndex();
			} else if (config.toolHash !== currentHash) {
				// ── Tools changed: re-categorize with saved model ──
				const reran = await runLlmCategorization(ctx);
				if (reran) {
					// Show wizard so user can configure new groups
					if (ctx.hasUI) await runSetupWizard(ctx);
					saveConfigToPath(getConfigPath(), config!);
				} else {
					// LLM failed — wipe config, show first-time setup again
					config = null;
					if (ctx.hasUI) {
						await runSetupWizard(ctx, { firstTime: true });
					}
					if (!config) {
						isEnabled = false;
						ctx.ui.setStatus("lazy-tools", undefined);
						ctx.ui.notify("lazy-tools: recategorization failed, disabled. Use /tools-setup to retry.", "warning");
						return;
					}
				}
			}
		}

		if (config) applyActiveTools();
		updateStatus(ctx);

		// Watch for async tool registrations (e.g. vault MCP discovery).
		// When new tools appear, merge them into existing groups via prefix detection.
		// Does NOT re-run LLM or update the config hash — that only happens
		// during first-time setup or explicit /tools-setup.
		if (config) {
			const watchInitialCount = pi.getAllTools().length;
			watchForAsyncTools({
				getToolCount: () => pi.getAllTools().length,
				onStabilized: async () => {
					const newCount = pi.getAllTools().length;
					if (newCount === watchInitialCount) return; // no change

					// Merge new tools into existing groups via prefix detection.
					// Existing group assignments are preserved; only unassigned tools
					// get categorized and added.
					const allTools = pi.getAllTools();
					const known = new Set(toolGroups.flatMap(g => g.tools));
					const newTools = allTools.filter(t => !known.has(t.name));
					if (newTools.length > 0) {
						const newGroups = categorizeTools(newTools);
						for (const ng of newGroups) {
							const existing = toolGroups.find(g => g.name === ng.name);
							if (existing) {
								// Merge tools into existing group
								existing.tools.push(...ng.tools);
							} else {
								// New group — add with on-demand default
								toolGroups.push(ng);
								if (config) config.groups[ng.name] = "on-demand";
							}
						}
						rebuildIndex();
					}
					applyActiveTools();
					updateStatus(ctx);
				},
			});
		}
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
