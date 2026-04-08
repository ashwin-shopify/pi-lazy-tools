/**
 * Pure logic for lazy-tools, extracted for testability.
 * No pi framework imports — only stdlib.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolLike {
	name: string;
}

export interface ToolGroup {
	name: string;
	displayName: string;
	tools: string[];
	description: string;
}

export type GroupMode = "always" | "on-demand" | "off";

export interface LazyToolsConfig {
	version: 1;
	groups: Record<string, GroupMode>;
}

// ─── Prefix Map ──────────────────────────────────────────────────────────────

export const PREFIX_MAP: Record<string, { displayName: string; description: string }> = {
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

// ─── Tool Categorization ─────────────────────────────────────────────────────

/** Categorize tools into groups by prefix. Unknown tools go into "core". */
export function categorizeTools(allTools: ToolLike[]): ToolGroup[] {
	const groups = new Map<string, string[]>();
	const coreTools: string[] = [];

	for (const tool of allTools) {
		let matched = false;
		for (const prefix of Object.keys(PREFIX_MAP)) {
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

	if (coreTools.length > 0) {
		result.push({
			name: "core",
			displayName: "Core",
			tools: coreTools,
			description: "Essential tools: read, write, edit, bash, ask, set_session_label, etc.",
		});
	}

	const sortedPrefixes = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
	for (const [prefix, tools] of sortedPrefixes) {
		const meta = PREFIX_MAP[prefix]!;
		result.push({
			name: prefix,
			displayName: meta.displayName,
			tools,
			description: meta.description,
		});
	}

	return result;
}

// ─── Group Mode Resolution ───────────────────────────────────────────────────

export function getGroupMode(config: LazyToolsConfig | null, groupName: string): GroupMode {
	if (!config) return "always";
	if (groupName === "core") return "always";
	return config.groups[groupName] ?? "on-demand";
}

// ─── Active Tool Computation ─────────────────────────────────────────────────

export function computeActiveTools(
	toolGroups: ToolGroup[],
	config: LazyToolsConfig | null,
	sessionActivated: Set<string>,
): string[] {
	const tools: string[] = [];
	for (const group of toolGroups) {
		const mode = getGroupMode(config, group.name);
		if (mode === "always" || sessionActivated.has(group.name)) {
			tools.push(...group.tools);
		}
	}
	if (!tools.includes("load_tools")) {
		tools.push("load_tools");
	}
	return tools;
}

// ─── Loadable Groups ─────────────────────────────────────────────────────────

export function getLoadableGroups(
	toolGroups: ToolGroup[],
	config: LazyToolsConfig | null,
	sessionActivated: Set<string>,
): ToolGroup[] {
	return toolGroups.filter((g) => {
		const mode = getGroupMode(config, g.name);
		return mode === "on-demand" && !sessionActivated.has(g.name);
	});
}

// ─── Load Tools Logic ────────────────────────────────────────────────────────

export interface LoadResult {
	loaded: string[];
	alreadyActive: string[];
	notFound: string[];
	disabled: string[];
}

export function loadGroups(
	groupNames: string[],
	toolGroups: ToolGroup[],
	config: LazyToolsConfig | null,
	sessionActivated: Set<string>,
): LoadResult {
	const loaded: string[] = [];
	const alreadyActive: string[] = [];
	const notFound: string[] = [];
	const disabled: string[] = [];

	for (const name of groupNames) {
		const group = toolGroups.find((g) => g.name === name);
		if (!group) {
			notFound.push(name);
			continue;
		}
		const mode = getGroupMode(config, name);
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

	return { loaded, alreadyActive, notFound, disabled };
}

// ─── Async Tool Watch ────────────────────────────────────────────────────────

export interface WatchForAsyncToolsOptions {
	/** Returns the current tool count. */
	getToolCount: () => number;
	/** Called when new tools are detected and count has stabilized. */
	onStabilized: () => void;
	/** Max time to poll in ms. Default: 5000. */
	maxWaitMs?: number;
	/** Poll interval in ms. Default: 250. */
	pollIntervalMs?: number;
	/** Number of consecutive stable checks before triggering. Default: 3. */
	stableThreshold?: number;
}

/**
 * Polls for async tool registrations (e.g. vault MCP discovery) and calls
 * onStabilized once the tool count changes and then holds steady.
 * Returns a cleanup function to cancel the poll.
 */
export function watchForAsyncTools(opts: WatchForAsyncToolsOptions): () => void {
	const maxWaitMs = opts.maxWaitMs ?? 5000;
	const pollIntervalMs = opts.pollIntervalMs ?? 250;
	const stableThreshold = opts.stableThreshold ?? 3;

	const initialCount = opts.getToolCount();
	let lastCount = initialCount;
	let stableChecks = 0;
	const startTime = Date.now();

	const poll = setInterval(() => {
		const currentCount = opts.getToolCount();
		if (currentCount === lastCount) {
			stableChecks++;
		} else {
			stableChecks = 0;
			lastCount = currentCount;
		}

		const timedOut = Date.now() - startTime > maxWaitMs;
		const stabilized = currentCount !== initialCount && stableChecks >= stableThreshold;

		if (stabilized || timedOut) {
			clearInterval(poll);
			if (currentCount !== initialCount) {
				opts.onStabilized();
			}
		}
	}, pollIntervalMs);

	return () => clearInterval(poll);
}

// ─── System Prompt Injection ─────────────────────────────────────────────────

export function buildLazyGroupsPrompt(loadableGroups: ToolGroup[]): string {
	if (loadableGroups.length === 0) return "";

	const groupList = loadableGroups
		.map((g) => `- ${g.name}: ${g.description} (${g.tools.length} tools)`)
		.join("\n");

	return `\n## Lazy-loadable tool groups

The following tool groups are available but NOT currently loaded. Call load_tools(groups: ["<name>"]) to activate them before using any of their tools.

${groupList}

Do NOT hallucinate tools from inactive groups. Call load_tools first.`;
}

// ─── Config Persistence ──────────────────────────────────────────────────────

export function loadConfigFromPath(path: string): LazyToolsConfig | null {
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as LazyToolsConfig;
	} catch {
		return null;
	}
}

export function saveConfigToPath(path: string, config: LazyToolsConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Config Reconciliation ──────────────────────────────────────────────────

export interface ReconcileResult {
	config: LazyToolsConfig;
	/** Group names that were removed because they no longer have installed tools. */
	prunedGroups: string[];
}

/**
 * Remove stale group entries from a saved config.
 * A group is stale when it appears in config.groups but has no corresponding
 * entry in the currently discovered toolGroups (i.e. the package was uninstalled).
 */
export function reconcileConfig(
	config: LazyToolsConfig,
	toolGroups: ToolGroup[],
): ReconcileResult {
	const validGroupNames = new Set(toolGroups.map((g) => g.name));
	const prunedGroups = Object.keys(config.groups).filter((k) => !validGroupNames.has(k));

	if (prunedGroups.length === 0) return { config, prunedGroups: [] };

	const groups = { ...config.groups };
	for (const key of prunedGroups) {
		delete groups[key];
	}

	return { config: { ...config, groups }, prunedGroups };
}

// ─── Default Config ──────────────────────────────────────────────────────────

export function buildDefaultConfig(toolGroups: ToolGroup[]): LazyToolsConfig {
	const groups: Record<string, GroupMode> = {};
	for (const group of toolGroups) {
		groups[group.name] = group.name === "core" || group.name === "memory" ? "always" : "on-demand";
	}
	return { version: 1, groups };
}
