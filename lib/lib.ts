/**
 * Pure logic for lazy-tools, extracted for testability.
 * No pi framework imports — only stdlib.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolLike {
	name: string;
	description?: string;
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
	/** Model used for LLM categorization (e.g. "google/gemini-2.0-flash") */
	categorizationModel?: string;
	/** Hash of tool names when groups were last generated */
	toolHash?: string;
	/** LLM-generated group definitions (cached) */
	toolGroups?: ToolGroup[];
}

// ─── Prompt-based Group Detection ────────────────────────────────────────────

/**
 * Build match tokens from a group's existing metadata (name, displayName,
 * description, tool names). Fully dynamic — no hardcoded keyword lists.
 */
// Common words that appear in many prompts — never index as match tokens.
const STOP_WORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
	"her", "was", "one", "our", "out", "has", "have", "been", "some",
	"them", "than", "its", "over", "such", "that", "with", "this", "will",
	"each", "make", "like", "from", "just", "into", "what", "when", "your",
	"how", "get", "set", "use", "run", "see", "let", "try", "may",
	"read", "write", "edit", "list", "find", "call", "check", "show",
	"create", "update", "delete", "manage", "search", "send", "load",
	"tool", "tools", "file", "files", "data", "name", "type", "help",
	"status", "start", "stop", "open", "close", "next", "last",
	"message", "skill", "agent", "system", "query", "info",
	"google", "work", "workspace",
]);

/**
 * Pre-computed inverted index for fast prompt→group detection.
 * Built once when tool groups change; per-message lookup is O(prompt_words).
 *
 * Three detection strategies, checked in order:
 * 1. Word lookup — tokenize prompt into words, lookup each in a Map (O(1) per word)
 * 2. Phrase scan — multi-word display names checked via includes() (only for unmatched groups)
 * 3. URL hostname — extract URLs, match hostname parts against display name words
 */
export class GroupIndex {
	/** Single-word token → group names */
	private wordMap = new Map<string, string[]>();
	/** Multi-word tokens (full display names) for substring matching */
	private phrases: Array<{ phrase: string; group: string }> = [];

	constructor(groups: ToolGroup[]) {
		for (const group of groups) {
			const name = group.name;

			// Index: group name (e.g. "gcal")
			this.addWord(name.toLowerCase(), name);

			// Index: individual display name words that pass the stop-word filter
			// e.g. "Google Calendar" → index "calendar" ("google" is stopped)
			const displayWords = group.displayName.toLowerCase().split(/\s+/);
			for (const w of displayWords) {
				if (w.length >= 4 && !STOP_WORDS.has(w)) {
					this.addWord(w, name);
				}
			}

			// Phrase: full display name for substring matching
			// e.g. "google calendar" matches "check my google calendar"
			const fullDisplay = group.displayName.toLowerCase();
			if (fullDisplay.includes(" ")) {
				this.phrases.push({ phrase: fullDisplay, group: name });
			}

		}
	}

	private addWord(word: string, group: string): void {
		const existing = this.wordMap.get(word);
		if (existing) {
			if (!existing.includes(group)) existing.push(group);
		} else {
			this.wordMap.set(word, [group]);
		}
	}

	/**
	 * Detect which groups a prompt references via keyword/phrase matching.
	 * O(prompt_words) for word lookup + O(phrases) for substring scan.
	 * @param loadable — optional set of group names to restrict results to
	 */
	detect(prompt: string, loadable?: Set<string>): string[] {
		if (!prompt) return [];
		const lower = prompt.toLowerCase();
		const matched = new Set<string>();

		// 1. Word lookup — split prompt into words, O(1) map lookup each
		const words = lower.split(/[\s,;:!?()\[\]{}"'`]+/);
		for (const w of words) {
			if (w.length < 2) continue;
			const groups = this.wordMap.get(w);
			if (groups) {
				for (const g of groups) {
					if (!loadable || loadable.has(g)) matched.add(g);
				}
			}
		}

		// 2. Phrase scan — multi-word display names (only unmatched groups)
		for (const { phrase, group } of this.phrases) {
			if (matched.has(group)) continue;
			if (loadable && !loadable.has(group)) continue;
			if (lower.includes(phrase)) {
				matched.add(group);
			}
		}

		return [...matched];
	}

	/** Check if prompt contains a URL. */
	static hasUrl(prompt: string): boolean {
		return /https?:\/\//.test(prompt);
	}
}

/**
 * Legacy wrapper — builds a throwaway index per call.
 * Prefer building a GroupIndex once and calling index.detect() per message.
 */
export function detectGroupsFromPrompt(
	prompt: string,
	loadableGroups: ToolGroup[],
): string[] {
	return new GroupIndex(loadableGroups).detect(prompt);
}

// ─── Tool Categorization ─────────────────────────────────────────────────────

/**
 * Extract the group prefix from a tool name.
 * Tries multi-segment prefixes first (e.g. "data_portal" from "data_portal_query"),
 * then falls back to first segment (e.g. "vault" from "vault_get_user").
 * Returns null for tools with no separator (e.g. "read", "bash").
 */
function extractPrefix(toolName: string): string | null {
	const sepIdx = toolName.indexOf("_");
	const dotIdx = toolName.indexOf(".");
	if (sepIdx === -1 && dotIdx === -1) return null;

	const firstSep = sepIdx === -1 ? dotIdx : dotIdx === -1 ? sepIdx : Math.min(sepIdx, dotIdx);
	return toolName.slice(0, firstSep);
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildDisplayName(prefix: string): string {
	return prefix.split(/[_.]/).map(capitalize).join(" ");
}

function buildDescription(prefix: string, tools: string[]): string {
	// Derive description from tool suffixes
	const suffixes = tools.map((t) => {
		const rest = t.slice(prefix.length + 1); // skip "prefix_"
		return rest.replace(/[_.]/g, " ");
	}).filter(Boolean);
	if (suffixes.length === 0) return `${buildDisplayName(prefix)} tools`;
	return `${buildDisplayName(prefix)}: ${suffixes.join(", ")}`;
}

/**
 * Categorize tools into groups by detecting shared prefixes from tool names.
 * No hardcoded prefix list — groups emerge from the tools themselves.
 * LLM categorization later replaces these with richer names/descriptions.
 *
 * A prefix needs 2+ tools to form a group. Single-prefix tools go to "core".
 */
export function categorizeTools(allTools: ToolLike[]): ToolGroup[] {
	// Phase 1: Bucket tools by first-segment prefix
	const prefixBuckets = new Map<string, string[]>();
	const noPrefix: string[] = [];

	for (const tool of allTools) {
		const prefix = extractPrefix(tool.name);
		if (!prefix) {
			noPrefix.push(tool.name);
			continue;
		}
		const existing = prefixBuckets.get(prefix) ?? [];
		existing.push(tool.name);
		prefixBuckets.set(prefix, existing);
	}

	// Phase 2: Promote buckets with 2+ tools to groups; singletons go to core
	const coreTools = [...noPrefix];
	const groups = new Map<string, string[]>();

	for (const [prefix, tools] of prefixBuckets) {
		if (tools.length >= 2) {
			groups.set(prefix, tools);
		} else {
			coreTools.push(...tools);
		}
	}

	// Phase 3: Build result
	const result: ToolGroup[] = [];

	if (coreTools.length > 0) {
		result.push({
			name: "core",
			displayName: "Core",
			tools: coreTools,
			description: "Essential tools: read, write, edit, bash, ask, set_session_label, etc.",
		});
	}

	const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
	for (const [prefix, tools] of sortedGroups) {
		result.push({
			name: prefix,
			displayName: buildDisplayName(prefix),
			tools,
			description: buildDescription(prefix, tools),
		});
	}

	ensureCoreTools(result);
	return result;
}

// ─── LLM-based Categorization ────────────────────────────────────────────────

/** Deterministic hash of sorted tool names — used to invalidate cache. */
export function computeToolHash(tools: ToolLike[]): string {
	const sorted = tools.map((t) => t.name).sort().join("\n");
	return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

/** Build the system prompt for the categorization LLM call. */
export function buildCategorizationPrompt(tools: ToolLike[]): string {
	const toolList = tools
		.map((t) => t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`)
		.join("\n");

	return `You are a tool categorizer for a coding assistant. Group these tools so that tools a user needs together are in the same group.

Goals:
- Group by PURPOSE and SERVICE, not just by name prefix
- Tools from the same service belong together (e.g. all Google Docs, Sheets, Drive, Workspace tools → one "Google" group)
- Tools the user always needs (file I/O, code editing, shell, asking questions, output handling, session management) → "core" group
- Aim for 3-6 groups total. Fewer is better. Avoid catch-all "utility" groups.
- Each group needs: name (short lowercase id), displayName (human-readable), description (one line), tools (array)
- Every tool must appear in exactly one group

Tools:
${toolList}

Respond with ONLY valid JSON, no markdown fences:
{"groups":[{"name":"core","displayName":"Core","description":"File I/O, code editing, shell, questions, output handling","tools":["read","write","bash","ask"]},{"name":"google","displayName":"Google","description":"Docs, Sheets, Drive, Calendar, Gmail, Workspace","tools":["gdocs_create","gsheets_read"]}]}`;
}

/** Parse LLM response into ToolGroup[]. Returns null if parsing fails. */
export function parseCategorizationResponse(response: string, allToolNames: string[]): ToolGroup[] | null {
	try {
		// Strip markdown fences if present
		let json = response.trim();
		if (json.startsWith("```")) {
			json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
		}

		const parsed = JSON.parse(json) as { groups: ToolGroup[] };
		if (!parsed.groups || !Array.isArray(parsed.groups)) return null;

		// Validate: every tool must appear exactly once
		const allAssigned = new Set<string>();
		for (const group of parsed.groups) {
			if (!group.name || !group.tools || !Array.isArray(group.tools)) return null;
			for (const tool of group.tools) {
				allAssigned.add(tool);
			}
			// Ensure displayName and description exist
			group.displayName = group.displayName || buildDisplayName(group.name);
			group.description = group.description || `${group.displayName} tools`;
		}

		// Check no tools were lost
		const expected = new Set(allToolNames);
		for (const name of expected) {
			if (!allAssigned.has(name)) return null; // LLM missed a tool
		}

		ensureCoreTools(parsed.groups);
		return parsed.groups;
	} catch {
		return null;
	}
}

// ─── Core Group Enforcement ─────────────────────────────────────────────────

/** Tools that must always be in the core group, regardless of categorization. */
const CORE_TOOLS = new Set(["load_tools"]);

/**
 * Ensure CORE_TOOLS are in the core group.
 * Moves them from whatever group the LLM/prefix detection placed them in.
 * Call after any categorization (prefix or LLM).
 */
export function ensureCoreTools(groups: ToolGroup[]): void {
	// Collect all tool names across all groups
	const allTools = new Set(groups.flatMap(g => g.tools));

	// Only enforce for CORE_TOOLS that actually exist in the tool set
	const toMove = [...CORE_TOOLS].filter(t => allTools.has(t));
	if (toMove.length === 0) return;

	let core = groups.find(g => g.name === "core");
	if (!core) {
		core = { name: "core", displayName: "Core", tools: [], description: "Essential tools" };
		groups.unshift(core);
	}
	for (const toolName of toMove) {
		// Remove from any non-core group
		for (const g of groups) {
			if (g.name !== "core") {
				const idx = g.tools.indexOf(toolName);
				if (idx !== -1) g.tools.splice(idx, 1);
			}
		}
		// Add to core if not already there
		if (!core.tools.includes(toolName)) {
			core.tools.push(toolName);
		}
	}
	// Remove empty groups that lost all their tools
	for (let i = groups.length - 1; i >= 0; i--) {
		if (groups[i].tools.length === 0) groups.splice(i, 1);
	}
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

export function buildDefaultConfig(
	toolGroups: ToolGroup[],
	opts?: { model?: string; toolHash?: string },
): LazyToolsConfig {
	const groups: Record<string, GroupMode> = {};
	for (const group of toolGroups) {
		groups[group.name] = "on-demand";
	}
	return {
		version: 1,
		groups,
		...(opts?.model && { categorizationModel: opts.model }),
		...(opts?.toolHash && { toolHash: opts.toolHash }),
		...(toolGroups.length > 0 && { toolGroups }),
	};
}

/**
 * Merge LLM-generated groups into an existing config.
 * Preserves user mode preferences for existing groups, defaults new ones to on-demand.
 */
export function mergeGroupsIntoConfig(
	config: LazyToolsConfig,
	newGroups: ToolGroup[],
	toolHash: string,
): LazyToolsConfig {
	const modes = { ...config.groups };
	for (const group of newGroups) {
		if (!(group.name in modes)) {
			modes[group.name] = "on-demand";
		}
	}
	// Remove modes for groups that no longer exist
	const validNames = new Set(newGroups.map((g) => g.name));
	for (const key of Object.keys(modes)) {
		if (!validNames.has(key)) delete modes[key];
	}
	return {
		...config,
		groups: modes,
		toolHash,
		toolGroups: newGroups,
	};
}
