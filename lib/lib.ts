/**
 * Pure logic for lazy-tools, extracted for testability.
 * No pi framework imports — only stdlib.
 */

import { hash as cryptoHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
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
	/**
	 * Preserve user group modes across LLM re-categorization renames by matching
	 * new groups to old ones by tool-set signature instead of by group name.
	 * Opt-in (default off) so existing behaviour is unchanged until enabled.
	 */
	preserveModesBySignature?: boolean;
	/**
	 * Stop filtering tools in spawned agents and non-interactive sessions.
	 * Opt-in (default off). Lives in the shared config file, so a teammate
	 * process reads the same setting the lead wrote.
	 */
	passthrough?: PassthroughConfig;
	/** Tuning for the LLM categorization prompt. */
	categorization?: CategorizationConfig;
	/**
	 * Run LLM categorization off the awaited startup path on the
	 * tool-set-changed and first-run paths. Opt-in (default off): when enabled,
	 * cached groups apply immediately and the LLM pass runs in the background,
	 * so startup is not blocked on model latency. The first prompt after a
	 * tool-set change may briefly see the previous grouping until it lands.
	 */
	backgroundCategorization?: BackgroundCategorizationConfig;
}

export interface PassthroughConfig {
	/** Master switch. When false or absent, passthrough never triggers. */
	enabled?: boolean;
	/** Run modes (ctx.mode) that trigger passthrough. Default: rpc, json, print. */
	modes?: string[];
	/** Env var names whose presence marks a spawned session. Default: PI_TEAM_ROLE. */
	envMarkers?: string[];
}

export interface BackgroundCategorizationConfig {
	/** Master switch. When false or absent, categorization stays blocking. */
	enabled?: boolean;
}

export interface CategorizationConfig {
	/** Lower bound of the group-count target in the prompt. Default 8. */
	minGroups?: number;
	/** Upper bound of the group-count target in the prompt. Default 12. */
	maxGroups?: number;
	/** Override for the grouping-guidance bullet lines. */
	guidance?: string;
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

function buildDescription(prefix: string, displayName: string, tools: string[]): string {
	// Derive description from tool suffixes. The display name is passed in rather
	// than recomputed here: the caller already built it for the group, and
	// buildDisplayName does a split+map+join that is wasted work when repeated
	// once per group.
	const suffixes = tools.map((t) => {
		const rest = t.slice(prefix.length + 1); // skip "prefix_"
		return rest.replace(/[_.]/g, " ");
	}).filter(Boolean);
	if (suffixes.length === 0) return `${displayName} tools`;
	return `${displayName}: ${suffixes.join(", ")}`;
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
		const existing = prefixBuckets.get(prefix);
		if (existing) {
			existing.push(tool.name);
		} else {
			// Only touch the map when creating a bucket; existing arrays are
			// mutated in place, so re-setting them each time is wasted work.
			prefixBuckets.set(prefix, [tool.name]);
		}
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
		const displayName = buildDisplayName(prefix);
		result.push({
			name: prefix,
			displayName,
			tools,
			description: buildDescription(prefix, displayName, tools),
		});
	}

	ensureCoreTools(result);
	return result;
}

// ─── LLM-based Categorization ────────────────────────────────────────────────

/** Deterministic, order-independent hash of tool names — used to invalidate cache. */
export function computeToolHash(tools: ToolLike[]): string {
	// Order-independence used to come from sorting the name strings, which
	// dominated this hash (~2.6us for a realistic catalog: string comparison is
	// per-character). Instead, map each name to a 53-bit numeric fingerprint and
	// sort a typed array, whose native sort is numeric and needs no comparator.
	// Same guarantees (deterministic, order-independent, detects any tool-set
	// change) at a fraction of the cost. This is a cache token, not a security
	// hash; a fingerprint collision would at worst leave a grouping stale until
	// the next real change. Changing the scheme changes the stored value, so
	// existing sessions re-categorize once on upgrade, same as any hash change.
	const fingerprints = new Float64Array(tools.length);
	for (let i = 0; i < tools.length; i++) fingerprints[i] = cyrb53(tools[i].name);
	fingerprints.sort();
	return cryptoHash("sha256", Buffer.from(fingerprints.buffer), "hex").slice(0, 16);
}

/**
 * cyrb53: a fast, well-distributed 53-bit string hash (public domain). Gives each
 * tool name a compact numeric fingerprint for the order-independent tool-set
 * hash. Integer math kept within 2^53 so the result is exact and identical
 * across platforms. Not a cryptographic hash.
 */
function cyrb53(str: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Build the system prompt for the categorization LLM call. */
/** Default grouping guidance: one service per group, no catch-alls. */
export const DEFAULT_CATEGORIZATION_GUIDANCE = [
	"- Group by PURPOSE and SERVICE, not just by name prefix",
	"- Each distinct service or platform gets its OWN group (e.g. Buildkite, Observe, Slack, Grokt, Vault, GitHub, Data Portal — all separate)",
	"- Do NOT merge unrelated services into one group. \"Shopify Developer Tools\" combining Buildkite + Grokt + Vault + GitHub is too broad — split them.",
].join("\n");

export function buildCategorizationPrompt(tools: ToolLike[], opts?: CategorizationConfig): string {
	const toolList = tools
		.map((t) => t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`)
		.join("\n");

	const minGroups = opts?.minGroups ?? 8;
	const maxGroups = opts?.maxGroups ?? 12;
	const guidance = opts?.guidance ?? DEFAULT_CATEGORIZATION_GUIDANCE;

	return `You are a tool categorizer for a coding assistant. Group these tools so that tools a user needs together are in the same group.

Goals:
${guidance}
- Tools the user always needs (file I/O, code editing, shell, asking questions, output handling, session management) → "core" group
- Aim for ${minGroups}-${maxGroups} fine-grained groups. Prefer more specific groups over fewer broad ones. Avoid catch-all "utility" groups.
- Each group needs: name (short lowercase id), displayName (human-readable), description (one line), tools (array)
- Every tool must appear in exactly one group

Tools:
${toolList}

Respond with ONLY valid JSON, no markdown fences:
{"groups":[{"name":"core","displayName":"Core","description":"File I/O, code editing, shell, questions, output handling","tools":["read","write","bash","ask"]},{"name":"google","displayName":"Google","description":"Docs, Sheets, Drive, Calendar, Gmail, Workspace","tools":["gdocs_create","gsheets_read"]}]}`;
}

/** Parse LLM response into ToolGroup[]. Returns null if parsing fails. */
/**
 * Pull a JSON object out of an LLM response that may be wrapped in a markdown
 * fence or surrounded by prose. Tries, in order: a fenced code block anywhere in
 * the text, the whole trimmed string, and the substring between the first "{"
 * and the last "}". Returns the first candidate that parses, else null. This
 * keeps categorization working when a model prefixes a sentence like "Here are
 * the groups:" or adds a trailing note around the JSON.
 */
function extractJsonObject(response: string): unknown {
	const text = response.trim();
	const candidates: string[] = [];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidates.push(fence[1].trim());
	candidates.push(text);
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try the next candidate
		}
	}
	return null;
}

export function parseCategorizationResponse(response: string, allToolNames: string[]): ToolGroup[] | null {
	try {
		// Models often wrap the JSON in a markdown fence or add a sentence before or
		// after it, so we do not assume the whole string is JSON.
		const parsed = extractJsonObject(response) as { groups: ToolGroup[] } | null;
		if (!parsed || !parsed.groups || !Array.isArray(parsed.groups)) return null;

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

		// Strip hallucinated tools (tools the LLM invented that don't exist)
		const validToolNames = new Set(allToolNames);
		for (const group of parsed.groups) {
			group.tools = group.tools.filter(t => validToolNames.has(t));
		}
		// Remove empty groups after stripping
		const groups = parsed.groups.filter(g => g.tools.length > 0);

		// Assign missed tools to core instead of rejecting
		const assigned = new Set(groups.flatMap(g => g.tools));
		const missed = allToolNames.filter(t => !assigned.has(t));
		if (missed.length > 0) {
			let core = groups.find(g => g.name === "core");
			if (!core) {
				core = { name: "core", displayName: "Core", description: "Core tools", tools: [] };
				groups.unshift(core);
			}
			core.tools.push(...missed);
		}

		ensureCoreTools(groups);
		return groups;
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

// ─── Passthrough (spawned / non-interactive sessions) ─────────────────────────

export const DEFAULT_PASSTHROUGH_MODES = ["rpc", "json", "print"];
export const DEFAULT_PASSTHROUGH_ENV_MARKERS = ["PI_TEAM_ROLE"];

/**
 * Decide whether lazy-tools should stop filtering for this session.
 *
 * pi has no native notion of a subagent: a spawned teammate is just a child
 * pi process the agent-teams extension launches. RPC-spawned children run in
 * mode "rpc"; pane-spawned children run in mode "tui" and are indistinguishable
 * from a human session except for the role marker the spawner injects. So we
 * combine a pi-native dimension (run mode) with a generic env-marker list, and
 * pass through when either matches. Returns false unless explicitly enabled.
 */
export function shouldPassthrough(
	passthrough: PassthroughConfig | undefined,
	mode: string,
	env: Record<string, string | undefined>,
): boolean {
	if (!passthrough?.enabled) return false;
	const modes = passthrough.modes ?? DEFAULT_PASSTHROUGH_MODES;

	if (modes.includes(mode)) return true;
	const markers = passthrough.envMarkers ?? DEFAULT_PASSTHROUGH_ENV_MARKERS;
	return markers.some((name) => {
		const value = env[name];
		return value !== undefined && value !== "";
	});
}

/**
 * Decide whether the tool-set-changed and first-run categorization should run
 * off the awaited startup path. Returns false unless explicitly enabled, so
 * default behaviour stays blocking and unchanged.
 */
export function shouldBackgroundCategorize(
	cfg: BackgroundCategorizationConfig | undefined,
): boolean {
	return cfg?.enabled === true;
}

/** Dependencies for the deferrable categorization orchestrator. */
export interface DeferredCategorizationDeps {
	/** Apply cached groups now, prefix-detecting any new tools. Cheap, synchronous. */
	applyCachedGroups: () => void;
	/** The slow path: LLM categorization plus apply and persist. */
	runCategorization: () => Promise<void>;
	/** Schedule background work off the awaited path. Defaults to a microtask. */
	schedule?: (task: () => void) => void;
}

/**
 * Run categorization on the tool-set-changed / first-run path, either blocking
 * (default) or deferred (opt-in). When deferred, cached groups are applied at
 * once and the LLM pass runs in the background, so startup is not blocked on
 * model latency.
 */
export async function runCategorizationMaybeDeferred(
	defer: boolean,
	deps: DeferredCategorizationDeps,
): Promise<void> {
	if (!defer) {
		await deps.runCategorization();
		return;
	}
	deps.applyCachedGroups();
	const schedule =
		deps.schedule ?? ((task: () => void) => void Promise.resolve().then(task));
	schedule(() => {
		// Background pass: swallow errors so an unhandled rejection can never
		// crash the session that already started without waiting for it.
		void deps.runCategorization().catch(() => {});
	});
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

/**
 * Buffer size for the fast config read. A fixed-size readSync skips the fstat
 * that readFileSync does to size its own buffer, saving a syscall on the awaited
 * startup path. 64 KiB covers a very large tool catalog (~900 tools); anything
 * bigger falls back to readFileSync so correctness never depends on the guess.
 */
const CONFIG_READ_BUFFER_BYTES = 65536;

/**
 * Reused across calls so the 64 KiB buffer is allocated once at module load
 * rather than on every startup. loadConfigFromPath is synchronous and
 * non-reentrant (no await between the read and the decode), each read overwrites
 * the buffer, and toString copies out only the bytes just read, so a shared
 * buffer is safe and leaks no uninitialized memory.
 */
const configReadBuffer = Buffer.allocUnsafe(CONFIG_READ_BUFFER_BYTES);

export function loadConfigFromPath(path: string): LazyToolsConfig | null {
	// Read directly and let a missing file throw, rather than paying a separate
	// existsSync stat on every startup. A missing file, unreadable file, or
	// invalid JSON all mean "no usable config", so one catch covers them.
	try {
		const config = JSON.parse(readConfigText(path)) as LazyToolsConfig;
		// toolGroups is persisted column-wise (see serializeConfig); rebuild the
		// ToolGroup[] the rest of the code expects. Legacy files stored it row-wise
		// as an array, so leave those untouched.
		if (config?.toolGroups && !Array.isArray(config.toolGroups)) {
			config.toolGroups = decodeToolGroups(config.toolGroups as unknown as EncodedToolGroups);
		}
		return config;
	} catch {
		return null;
	}
}

/**
 * Read a config file with one fewer syscall than readFileSync: a single fixed
 * buffer readSync avoids the fstat readFileSync uses to size its buffer. If the
 * file fills the buffer it may have been truncated, so re-read it fully; that
 * keeps arbitrarily large configs correct while the common small config takes
 * the fast path.
 */
function readConfigText(path: string): string {
	const fd = openSync(path, "r");
	try {
		const n = readSync(fd, configReadBuffer, 0, CONFIG_READ_BUFFER_BYTES, 0);
		if (n === CONFIG_READ_BUFFER_BYTES) {
			return readFileSync(path, "utf-8");
		}
		return configReadBuffer.toString("utf8", 0, n);
	} finally {
		closeSync(fd);
	}
}

export function saveConfigToPath(path: string, config: LazyToolsConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, serializeConfig(config), "utf-8");
}

/**
 * Serialize the config so the human-edited keys (version, groups, passthrough,
 * categorization) stay pretty-printed and readable, while toolGroups — the
 * machine-generated cache nobody hand-edits — is written compact. That is ~30%
 * fewer bytes and a measurably faster parse on the awaited startup read, and it
 * round-trips through JSON.parse identically. Falls back to a plain pretty
 * document when there is no toolGroups to set apart.
 */
function serializeConfig(config: LazyToolsConfig): string {
	const { toolGroups, ...rest } = config;
	const restStr = JSON.stringify(rest, null, 2);
	if (toolGroups === undefined) return restStr;
	// restStr ends with "\n}"; splice toolGroups in compact before the closing brace.
	return `${restStr.slice(0, -2)},\n  "toolGroups": ${JSON.stringify(encodeToolGroups(toolGroups))}\n}`;
}

/**
 * Column-wise (structure-of-arrays) form of the tool groups on disk. Array of
 * objects repeats the four field names once per group; storing four parallel
 * arrays writes each field name once, which is ~20% fewer bytes and a faster
 * JSON.parse (arrays of primitives allocate fewer objects than an array of
 * records). The saving grows with the group count. Round-trips exactly.
 */
interface EncodedToolGroups {
	names: string[];
	displayNames: string[];
	descriptions: string[];
	tools: string[][];
}

function encodeToolGroups(groups: ToolGroup[]): EncodedToolGroups {
	const names: string[] = [];
	const displayNames: string[] = [];
	const descriptions: string[] = [];
	const tools: string[][] = [];
	for (const g of groups) {
		names.push(g.name);
		displayNames.push(g.displayName);
		descriptions.push(g.description);
		tools.push(g.tools);
	}
	return { names, displayNames, descriptions, tools };
}

function decodeToolGroups(enc: EncodedToolGroups): ToolGroup[] {
	const groups: ToolGroup[] = [];
	for (let i = 0; i < enc.names.length; i++) {
		groups.push({
			name: enc.names[i],
			displayName: enc.displayNames[i],
			description: enc.descriptions[i],
			tools: enc.tools[i],
		});
	}
	return groups;
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

// ─── Model Auto-Selection ────────────────────────────────────────────────────

/**
 * Ranked list of preferred cheap/fast models for categorization.
 * Checked in order; first available one wins.
 */
const PREFERRED_CATEGORIZATION_MODELS: Array<{ provider: string; pattern: RegExp }> = [
	// Full flash first, newest first, quality over raw speed. A categorization
	// benchmark showed gemini-flash-latest gives the cleanest grouping at about
	// four seconds once thinking is disabled, while flash-lite variants are
	// faster but coarser, so lite ranks below full flash. The floating "latest"
	// alias leads so auto-select tracks Google's newest flash without a code
	// change. Non-lite patterns use a lookahead so a lite id never matches them.
	{ provider: "google", pattern: /gemini-flash-latest/i },
	{ provider: "google", pattern: /gemini-3.*flash(?!.*lite)/i },
	{ provider: "google", pattern: /gemini-2\.5-flash(?!.*lite)/i },
	{ provider: "google", pattern: /gemini.*flash(?!.*lite)/i },
	{ provider: "google", pattern: /gemini-flash-lite-latest/i },
	{ provider: "google", pattern: /gemini.*flash/i },
	{ provider: "anthropic", pattern: /haiku/i },
	{ provider: "openai", pattern: /gpt-4o-mini/i },
	{ provider: "openai", pattern: /(mini|nano)/i },
];

export interface ModelLike {
	provider: string;
	id: string;
}

/**
 * Auto-select the best cheap/fast model from available models.
 * Returns "provider/id" string or null if no match found.
 */
export function autoSelectCategorizationModel(available: ModelLike[]): string | null {
	for (const pref of PREFERRED_CATEGORIZATION_MODELS) {
		const match = available.find(
			(m) => m.provider === pref.provider && pref.pattern.test(m.id),
		);
		if (match) return `${match.provider}/${match.id}`;
	}
	// Fallback: first available model
	if (available.length > 0) {
		return `${available[0].provider}/${available[0].id}`;
	}
	return null;
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
	const modes: Record<string, GroupMode> = config.preserveModesBySignature
		? mergeModesBySignature(config, newGroups)
		: mergeModesByName(config.groups, newGroups);
	return {
		...config,
		groups: modes,
		toolHash,
		toolGroups: newGroups,
	};
}

/** Name-keyed merge: preserve modes for same-named groups, drop stale ones. */
function mergeModesByName(
	oldModes: Record<string, GroupMode>,
	newGroups: ToolGroup[],
): Record<string, GroupMode> {
	const modes = { ...oldModes };
	for (const group of newGroups) {
		if (!(group.name in modes)) {
			modes[group.name] = "on-demand";
		}
	}
	const validNames = new Set(newGroups.map((g) => g.name));
	for (const key of Object.keys(modes)) {
		if (!validNames.has(key)) delete modes[key];
	}
	return modes;
}

/**
 * Signature-keyed merge: preserve modes across renames. A new group keeps its
 * mode by name when the name still exists; otherwise it inherits the mode of
 * the old group its tools most came from. This survives the LLM renaming a
 * cluster (e.g. "team_management" → "team"), which is what silently reset
 * "always" choices to "on-demand" before.
 */
function mergeModesBySignature(
	config: LazyToolsConfig,
	newGroups: ToolGroup[],
): Record<string, GroupMode> {
	const oldGroups = config.toolGroups ?? [];
	const modes: Record<string, GroupMode> = {};
	for (const group of newGroups) {
		if (group.name in config.groups) {
			modes[group.name] = config.groups[group.name];
			continue;
		}
		modes[group.name] = inheritModeBySignature(group, oldGroups, config.groups) ?? "on-demand";
	}
	return modes;
}

/**
 * Find the mode of the old group that a new group's tools most came from.
 * Returns the inherited mode when at least half of the new group's tools were
 * in a single old group, otherwise undefined.
 */
export function inheritModeBySignature(
	newGroup: ToolGroup,
	oldGroups: ToolGroup[],
	oldModes: Record<string, GroupMode>,
): GroupMode | undefined {
	if (newGroup.tools.length === 0) return undefined;
	const newSet = new Set(newGroup.tools);
	let best: { name: string; shared: number } | null = null;
	for (const old of oldGroups) {
		const shared = old.tools.filter((tool) => newSet.has(tool)).length;
		if (shared === 0) continue;
		if (!best || shared > best.shared) best = { name: old.name, shared };
	}
	if (!best) return undefined;
	if (best.shared / newGroup.tools.length < 0.5) return undefined;
	return oldModes[best.name];
}
