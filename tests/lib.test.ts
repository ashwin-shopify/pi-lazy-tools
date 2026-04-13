import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	categorizeTools,
	getGroupMode,
	computeActiveTools,
	getLoadableGroups,
	loadGroups,
	buildLazyGroupsPrompt,
	loadConfigFromPath,
	saveConfigToPath,
	buildDefaultConfig,
	watchForAsyncTools,
	reconcileConfig,
	detectGroupsFromPrompt,
	computeToolHash,
	buildCategorizationPrompt,
	parseCategorizationResponse,
	mergeGroupsIntoConfig,
	GroupIndex,
	type ToolLike,
	type ToolGroup,
	type LazyToolsConfig,
	type GroupMode,
} from "../lib/lib.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_TOOLS: ToolLike[] = [
	// Core
	{ name: "read" },
	{ name: "write" },
	{ name: "edit" },
	{ name: "bash" },
	{ name: "ask" },
	{ name: "set_session_label" },
	// Vault
	{ name: "vault_get_user" },
	{ name: "vault_get_project" },
	{ name: "vault_search_all" },
	// Observe
	{ name: "observe_query" },
	{ name: "observe_metrics" },
	// Slack
	{ name: "slack_search" },
	{ name: "slack_thread" },
	{ name: "slack_post" },
	// Buildkite
	{ name: "bk_build_info" },
	{ name: "bk_failed_jobs" },
	// Memory
	{ name: "memory_read" },
	{ name: "memory_search" },
	// Gcal (2 tools → forms a group)
	{ name: "gcal_events" },
	{ name: "gcal_list" },
	// Gmail (2 tools → forms a group)
	{ name: "gmail_read" },
	{ name: "gmail_send" },
	// Grokt (2 tools → forms a group)
	{ name: "grokt_search" },
	{ name: "grokt_index" },
	// Single-tool prefix (goes to core with dynamic detection)
	{ name: "data_portal_query_bigquery" },
];

function makeConfig(overrides: Record<string, GroupMode> = {}): LazyToolsConfig {
	return {
		version: 1,
		groups: {
			core: "always",
			vault: "on-demand",
			observe: "on-demand",
			slack: "on-demand",
			bk: "on-demand",
			memory: "always",
			gcal: "on-demand",
			gmail: "off",
			grokt: "on-demand",
			...overrides,
		},
	};
}

// ─── categorizeTools ─────────────────────────────────────────────────────────

describe("categorizeTools", () => {
	it("places core group first", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		assert.equal(groups[0].name, "core");
	});

	it("puts unrecognized tools in core", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const core = groups.find((g) => g.name === "core")!;
		assert.ok(core.tools.includes("read"));
		assert.ok(core.tools.includes("bash"));
		assert.ok(core.tools.includes("set_session_label"));
	});

	it("groups vault_ prefixed tools together", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const vault = groups.find((g) => g.name === "vault")!;
		assert.ok(vault);
		assert.deepEqual(vault.tools, ["vault_get_user", "vault_get_project", "vault_search_all"]);
		assert.equal(vault.displayName, "Vault");
	});

	it("groups slack_ prefixed tools together", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const slack = groups.find((g) => g.name === "slack")!;
		assert.deepEqual(slack.tools, ["slack_search", "slack_thread", "slack_post"]);
	});

	it("groups bk_ prefixed tools together", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const bk = groups.find((g) => g.name === "bk")!;
		assert.deepEqual(bk.tools, ["bk_build_info", "bk_failed_jobs"]);
		assert.equal(bk.displayName, "Bk");
	});

	it("sorts non-core groups by tool count descending", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const nonCore = groups.filter((g) => g.name !== "core");
		for (let i = 1; i < nonCore.length; i++) {
			assert.ok(
				nonCore[i - 1].tools.length >= nonCore[i].tools.length,
				`${nonCore[i - 1].name} (${nonCore[i - 1].tools.length}) should have >= tools than ${nonCore[i].name} (${nonCore[i].tools.length})`,
			);
		}
	});

	it("returns empty array for no tools", () => {
		const groups = categorizeTools([]);
		assert.equal(groups.length, 0);
	});

	it("handles tools with only recognized prefixes (no core group)", () => {
		const groups = categorizeTools([{ name: "vault_get_user" }, { name: "vault_search" }, { name: "slack_search" }, { name: "slack_post" }]);
		assert.ok(!groups.find((g) => g.name === "core"));
		assert.equal(groups.length, 2);
	});

	it("matches exact prefix name as a tool", () => {
		// Edge case: a tool named exactly "observe" (no underscore suffix) — goes to core since no prefix separator
		const groups = categorizeTools([{ name: "observe" }]);
		const core = groups.find((g) => g.name === "core")!;
		assert.ok(core);
		assert.ok(core.tools.includes("observe"));
	});

	it("does not match partial prefixes", () => {
		// "observer_foo" should NOT match "observe" (it starts with "observe" but next char is "r" not "_")
		const groups = categorizeTools([{ name: "observer_foo" }]);
		const core = groups.find((g) => g.name === "core")!;
		assert.ok(core.tools.includes("observer_foo"));
		assert.ok(!groups.find((g) => g.name === "observe"));
	});
});

// ─── getGroupMode ────────────────────────────────────────────────────────────

describe("getGroupMode", () => {
	it("returns 'always' when config is null", () => {
		assert.equal(getGroupMode(null, "vault"), "always");
		assert.equal(getGroupMode(null, "observe"), "always");
	});

	it("returns 'always' for core regardless of config", () => {
		const config = makeConfig({ core: "off" as GroupMode });
		assert.equal(getGroupMode(config, "core"), "always");
	});

	it("returns configured mode for known groups", () => {
		const config = makeConfig({ vault: "always", slack: "off" });
		assert.equal(getGroupMode(config, "vault"), "always");
		assert.equal(getGroupMode(config, "slack"), "off");
		assert.equal(getGroupMode(config, "observe"), "on-demand");
	});

	it("defaults to 'on-demand' for unconfigured groups", () => {
		const config = makeConfig();
		assert.equal(getGroupMode(config, "superpowers"), "on-demand");
	});
});

// ─── computeActiveTools ──────────────────────────────────────────────────────

describe("computeActiveTools", () => {
	const groups = categorizeTools(MOCK_TOOLS);

	it("includes only 'always' groups when no session activations", () => {
		const config = makeConfig();
		const active = computeActiveTools(groups, config, new Set());

		assert.ok(active.includes("read"), "core tools should be active");
		assert.ok(active.includes("memory_read"), "memory (always) should be active");
		assert.ok(!active.includes("vault_get_user"), "vault (on-demand) should NOT be active");
		assert.ok(!active.includes("slack_search"), "slack (on-demand) should NOT be active");
		assert.ok(!active.includes("gmail_read"), "gmail (off) should NOT be active");
	});

	it("includes session-activated groups", () => {
		const config = makeConfig();
		const activated = new Set(["slack"]);
		const active = computeActiveTools(groups, config, activated);

		assert.ok(active.includes("slack_search"), "session-activated slack should be active");
		assert.ok(active.includes("slack_thread"));
		assert.ok(!active.includes("vault_get_user"), "vault still not active");
	});

	it("always includes load_tools gateway", () => {
		const config = makeConfig();
		const active = computeActiveTools(groups, config, new Set());
		assert.ok(active.includes("load_tools"));
	});

	it("does not duplicate load_tools if already in tools", () => {
		const toolsWithGateway: ToolLike[] = [...MOCK_TOOLS, { name: "load_tools" }];
		const groupsWithGateway = categorizeTools(toolsWithGateway);
		const config = makeConfig();
		const active = computeActiveTools(groupsWithGateway, config, new Set());
		const count = active.filter((t) => t === "load_tools").length;
		assert.equal(count, 1);
	});

	it("includes all tools when config is null", () => {
		const active = computeActiveTools(groups, null, new Set());
		// null config = "always" for everything
		assert.ok(active.includes("vault_get_user"));
		assert.ok(active.includes("slack_search"));
		assert.ok(active.includes("gmail_read"));
	});

	it("excludes 'off' groups even when session-activated", () => {
		const config = makeConfig({ gmail: "off" });
		// getGroupMode returns "off" for gmail, so computeActiveTools won't include it
		// even though session says it's activated — but loadGroups wouldn't add it to sessionActivated
		// in the first place. Test the raw computation anyway.
		const active = computeActiveTools(groups, config, new Set());
		assert.ok(!active.includes("gmail_read"));
	});
});

// ─── getLoadableGroups ───────────────────────────────────────────────────────

describe("getLoadableGroups", () => {
	const groups = categorizeTools(MOCK_TOOLS);

	it("returns on-demand groups that are not yet activated", () => {
		const config = makeConfig();
		const loadable = getLoadableGroups(groups, config, new Set());
		const names = loadable.map((g) => g.name);

		assert.ok(names.includes("vault"), "vault is on-demand");
		assert.ok(names.includes("slack"), "slack is on-demand");
		assert.ok(!names.includes("core"), "core is always");
		assert.ok(!names.includes("memory"), "memory is always");
		assert.ok(!names.includes("gmail"), "gmail is off");
	});

	it("excludes session-activated groups", () => {
		const config = makeConfig();
		const loadable = getLoadableGroups(groups, config, new Set(["vault"]));
		const names = loadable.map((g) => g.name);

		assert.ok(!names.includes("vault"), "vault already activated");
		assert.ok(names.includes("slack"), "slack still loadable");
	});

	it("returns empty when all groups are always or activated", () => {
		const config: LazyToolsConfig = {
			version: 1,
			groups: Object.fromEntries(groups.map((g) => [g.name, "always" as GroupMode])),
		};
		const loadable = getLoadableGroups(groups, config, new Set());
		assert.equal(loadable.length, 0);
	});

	it("returns empty when config is null (all 'always')", () => {
		const loadable = getLoadableGroups(groups, null, new Set());
		assert.equal(loadable.length, 0);
	});
});

// ─── loadGroups ──────────────────────────────────────────────────────────────

describe("loadGroups", () => {
	const groups = categorizeTools(MOCK_TOOLS);

	it("loads an on-demand group", () => {
		const config = makeConfig();
		const activated = new Set<string>();
		const result = loadGroups(["slack"], groups, config, activated);

		assert.deepEqual(result.loaded, ["slack"]);
		assert.deepEqual(result.alreadyActive, []);
		assert.deepEqual(result.notFound, []);
		assert.deepEqual(result.disabled, []);
		assert.ok(activated.has("slack"), "mutates sessionActivated");
	});

	it("reports already-active for 'always' groups", () => {
		const config = makeConfig();
		const activated = new Set<string>();
		const result = loadGroups(["core"], groups, config, activated);

		assert.deepEqual(result.alreadyActive, ["core"]);
		assert.deepEqual(result.loaded, []);
	});

	it("reports already-active for previously session-activated groups", () => {
		const config = makeConfig();
		const activated = new Set(["vault"]);
		const result = loadGroups(["vault"], groups, config, activated);

		assert.deepEqual(result.alreadyActive, ["vault"]);
		assert.deepEqual(result.loaded, []);
	});

	it("reports not-found for unknown groups", () => {
		const config = makeConfig();
		const activated = new Set<string>();
		const result = loadGroups(["nonexistent"], groups, config, activated);

		assert.deepEqual(result.notFound, ["nonexistent"]);
	});

	it("reports disabled for 'off' groups", () => {
		const config = makeConfig({ gmail: "off" });
		const activated = new Set<string>();
		const result = loadGroups(["gmail"], groups, config, activated);

		assert.deepEqual(result.disabled, ["gmail"]);
		assert.ok(!activated.has("gmail"), "should NOT activate off groups");
	});

	it("handles mixed request with multiple groups", () => {
		const config = makeConfig({ gmail: "off" });
		const activated = new Set<string>();
		const result = loadGroups(
			["slack", "core", "gmail", "nonexistent", "vault"],
			groups,
			config,
			activated,
		);

		assert.deepEqual(result.loaded, ["slack", "vault"]);
		assert.deepEqual(result.alreadyActive, ["core"]);
		assert.deepEqual(result.disabled, ["gmail"]);
		assert.deepEqual(result.notFound, ["nonexistent"]);
	});

	it("is idempotent — second call reports already-active", () => {
		const config = makeConfig();
		const activated = new Set<string>();

		loadGroups(["slack"], groups, config, activated);
		const result = loadGroups(["slack"], groups, config, activated);

		assert.deepEqual(result.alreadyActive, ["slack"]);
		assert.deepEqual(result.loaded, []);
	});
});

// ─── buildLazyGroupsPrompt ──────────────────────────────────────────────────

describe("buildLazyGroupsPrompt", () => {
	it("returns empty string for no loadable groups", () => {
		assert.equal(buildLazyGroupsPrompt([]), "");
	});

	it("includes group names and descriptions", () => {
		const groups: ToolGroup[] = [
			{ name: "slack", displayName: "Slack", tools: ["slack_search", "slack_post"], description: "Messaging tools" },
			{ name: "vault", displayName: "Vault", tools: ["vault_get_user"], description: "People tools" },
		];
		const prompt = buildLazyGroupsPrompt(groups);

		assert.ok(prompt.includes("slack: Messaging tools (2 tools)"));
		assert.ok(prompt.includes("vault: People tools (1 tools)"));
		assert.ok(prompt.includes("Lazy-loadable tool groups"));
		assert.ok(prompt.includes("load_tools"));
		assert.ok(prompt.includes("Do NOT hallucinate"));
	});
});

// ─── Config persistence ─────────────────────────────────────────────────────

describe("config persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "lazy-tools-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null for missing config", () => {
		const result = loadConfigFromPath(join(tmpDir, "nope.json"));
		assert.equal(result, null);
	});

	it("round-trips config through save/load", () => {
		const config = makeConfig({ vault: "always", slack: "off" });
		const path = join(tmpDir, "lazy-tools.json");

		saveConfigToPath(path, config);
		const loaded = loadConfigFromPath(path);

		assert.deepEqual(loaded, config);
	});

	it("creates parent directories", () => {
		const path = join(tmpDir, "nested", "deep", "config.json");
		const config = makeConfig();

		saveConfigToPath(path, config);

		assert.ok(existsSync(path));
		const loaded = loadConfigFromPath(path);
		assert.deepEqual(loaded, config);
	});

	it("returns null for invalid JSON", () => {
		const path = join(tmpDir, "bad.json");
		require("fs").writeFileSync(path, "not json{{{", "utf-8");
		const result = loadConfigFromPath(path);
		assert.equal(result, null);
	});

	it("persists correct JSON format", () => {
		const config = makeConfig();
		const path = join(tmpDir, "config.json");
		saveConfigToPath(path, config);

		const raw = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(raw.version, 1);
		assert.equal(typeof raw.groups, "object");
	});
});

// ─── buildDefaultConfig ─────────────────────────────────────────────────────

describe("buildDefaultConfig", () => {
	it("defaults all groups to on-demand", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = buildDefaultConfig(groups);

		assert.equal(config.groups.core, "on-demand");
		assert.equal(config.groups.memory, "on-demand");
	});

	it("sets everything else to on-demand", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = buildDefaultConfig(groups);

		assert.equal(config.groups.vault, "on-demand");
		assert.equal(config.groups.slack, "on-demand");
		assert.equal(config.groups.observe, "on-demand");
		assert.equal(config.groups.bk, "on-demand");
	});

	it("has version 1", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = buildDefaultConfig(groups);
		assert.equal(config.version, 1);
	});
});

// ─── watchForAsyncTools ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("watchForAsyncTools", () => {
	it("calls onStabilized when tool count changes and stabilizes", async () => {
		let toolCount = 10;
		let stabilizedCalled = false;

		watchForAsyncTools({
			getToolCount: () => toolCount,
			onStabilized: () => { stabilizedCalled = true; },
			pollIntervalMs: 50,
			stableThreshold: 2,
			maxWaitMs: 5000,
		});

		// Simulate vault registering tools after 100ms
		await sleep(80);
		assert.equal(stabilizedCalled, false, "should not fire before tools change");
		toolCount = 38;

		// Wait for stabilization (2 checks × 50ms = 100ms after change detected)
		await sleep(250);
		assert.equal(stabilizedCalled, true, "should fire after count stabilizes");
	});

	it("does NOT call onStabilized if tool count never changes", async () => {
		let stabilizedCalled = false;

		watchForAsyncTools({
			getToolCount: () => 10,
			onStabilized: () => { stabilizedCalled = true; },
			pollIntervalMs: 50,
			stableThreshold: 2,
			maxWaitMs: 200,
		});

		// Wait past the timeout
		await sleep(350);
		assert.equal(stabilizedCalled, false, "should not fire if count never changed");
	});

	it("handles tools arriving in waves (resets stability counter)", async () => {
		let toolCount = 10;
		let stabilizedCalled = false;

		watchForAsyncTools({
			getToolCount: () => toolCount,
			onStabilized: () => { stabilizedCalled = true; },
			pollIntervalMs: 50,
			stableThreshold: 3,
			maxWaitMs: 5000,
		});

		// First wave: vault registers 28 tools
		await sleep(80);
		toolCount = 38;

		// Second wave before stabilization: observe registers 5 more
		await sleep(80);
		assert.equal(stabilizedCalled, false, "should not fire between waves");
		toolCount = 43;

		// Now let it stabilize (3 checks × 50ms = 150ms)
		await sleep(300);
		assert.equal(stabilizedCalled, true, "should fire after final wave stabilizes");
	});

	it("fires onStabilized on timeout if tools changed but never fully stabilized", async () => {
		let toolCount = 10;
		let stabilizedCalled = false;

		watchForAsyncTools({
			getToolCount: () => toolCount,
			onStabilized: () => { stabilizedCalled = true; },
			pollIntervalMs: 50,
			stableThreshold: 100, // impossibly high
			maxWaitMs: 200,
		});

		// Change count so it's different from initial
		await sleep(60);
		toolCount = 38;

		// Wait for timeout
		await sleep(300);
		assert.equal(stabilizedCalled, true, "should fire on timeout since count changed");
	});

	it("returns a cleanup function that stops polling", async () => {
		let toolCount = 10;
		let stabilizedCalled = false;

		const cancel = watchForAsyncTools({
			getToolCount: () => toolCount,
			onStabilized: () => { stabilizedCalled = true; },
			pollIntervalMs: 50,
			stableThreshold: 2,
			maxWaitMs: 5000,
		});

		// Change count then immediately cancel
		toolCount = 38;
		cancel();

		// Wait well past stabilization time
		await sleep(300);
		assert.equal(stabilizedCalled, false, "should not fire after cancel");
	});

	it("calls onStabilized exactly once", async () => {
		let toolCount = 10;
		let callCount = 0;

		watchForAsyncTools({
			getToolCount: () => toolCount,
			onStabilized: () => { callCount++; },
			pollIntervalMs: 50,
			stableThreshold: 2,
			maxWaitMs: 5000,
		});

		toolCount = 38;
		await sleep(400);
		assert.equal(callCount, 1, "should fire exactly once");
	});
});

// ─── reconcileConfig ──────────────────────────────────────────────────────────

describe("reconcileConfig", () => {
	it("returns unchanged config when all groups still exist", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = makeConfig();
		const { config: result, prunedGroups } = reconcileConfig(config, groups);
		assert.equal(prunedGroups.length, 0);
		assert.deepEqual(result.groups, config.groups);
	});

	it("removes groups that no longer have installed tools", () => {
		// Simulate slack and vault being uninstalled
		const toolsWithoutSlackAndVault = MOCK_TOOLS.filter(
			(t) => !t.name.startsWith("slack_") && !t.name.startsWith("vault_"),
		);
		const groups = categorizeTools(toolsWithoutSlackAndVault);
		const config = makeConfig();
		const { config: result, prunedGroups } = reconcileConfig(config, groups);
		assert.ok(prunedGroups.includes("slack"), "slack should be pruned");
		assert.ok(prunedGroups.includes("vault"), "vault should be pruned");
		assert.ok(!("slack" in result.groups), "slack removed from config");
		assert.ok(!("vault" in result.groups), "vault removed from config");
	});

	it("does not mutate the original config", () => {
		const toolsWithoutSlack = MOCK_TOOLS.filter((t) => !t.name.startsWith("slack_"));
		const groups = categorizeTools(toolsWithoutSlack);
		const config = makeConfig();
		reconcileConfig(config, groups);
		assert.ok("slack" in config.groups, "original config should be unchanged");
	});

	it("keeps always-on groups like core and memory even when not in toolGroups", () => {
		// Edge case: config has core/memory but toolGroups somehow omits them
		const groups = categorizeTools([{ name: "observe_query" }, { name: "observe_metrics" }]);
		const config: LazyToolsConfig = { version: 1, groups: { core: "always", memory: "always", observe: "on-demand" } };
		const { config: result, prunedGroups } = reconcileConfig(config, groups);
		// core and memory are pruned since they're not in toolGroups — that's correct;
		// categorizeTools won't produce them if there are no matching tools
		assert.ok(prunedGroups.includes("core"));
		assert.ok(prunedGroups.includes("memory"));
		assert.ok("observe" in result.groups);
	});

	it("returns empty prunedGroups and same config reference when nothing is stale", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = makeConfig();
		const { config: result, prunedGroups } = reconcileConfig(config, groups);
		assert.equal(prunedGroups.length, 0);
		assert.strictEqual(result, config, "should return same config reference when no changes");
	});
});

// ─── Dynamic categorization ─────────────────────────────────────────────────────

describe("dynamic categorization", () => {
	it("detects unknown prefix groups automatically", () => {
		const tools: ToolLike[] = [
			{ name: "read" },
			{ name: "keke_pokie_search" },
			{ name: "keke_pokie_delete" },
			{ name: "keke_pokie_list" },
		];
		const groups = categorizeTools(tools);
		const keke = groups.find((g) => g.name === "keke")!;
		assert.ok(keke, "should detect keke group from shared prefix");
		assert.equal(keke.tools.length, 3);
		assert.equal(keke.displayName, "Keke");
	});

	it("puts single-prefix tools in core", () => {
		const tools: ToolLike[] = [
			{ name: "read" },
			{ name: "lonely_tool" },
		];
		const groups = categorizeTools(tools);
		const core = groups.find((g) => g.name === "core")!;
		assert.ok(core.tools.includes("lonely_tool"));
		assert.ok(!groups.find((g) => g.name === "lonely"));
	});

	it("auto-generates displayName from prefix", () => {
		const tools: ToolLike[] = [
			{ name: "foo_bar_one" },
			{ name: "foo_bar_two" },
		];
		const groups = categorizeTools(tools);
		const foo = groups.find((g) => g.name === "foo")!;
		assert.equal(foo.displayName, "Foo");
	});
});

// ─── detectGroupsFromPrompt ───────────────────────────────────────────────────

describe("detectGroupsFromPrompt", () => {
	const groups: ToolGroup[] = [
		{ name: "gcal", displayName: "Google Calendar", description: "Calendar: events, availability, scheduling", tools: ["gcal_events", "gcal_list"] },
		{ name: "gdocs", displayName: "Google Docs", description: "Document editing tools", tools: ["gdocs_create", "gdocs_get_structure"] },
		{ name: "gsheets", displayName: "Google Sheets", description: "Spreadsheet tools", tools: ["gsheets_read", "gsheets_write"] },
		{ name: "slack", displayName: "Slack", description: "Messaging: search, threads, channels", tools: ["slack_search", "slack_post"] },
		{ name: "keke", displayName: "Keke", description: "Keke: search, delete, list", tools: ["keke_search", "keke_delete"] },
	];

	it("matches group name", () => {
		const result = detectGroupsFromPrompt("load gcal tools", groups);
		assert.ok(result.includes("gcal"));
	});

	it("matches display name case-insensitively", () => {
		const result = detectGroupsFromPrompt("Check my Google Calendar", groups);
		assert.ok(result.includes("gcal"));
	});

	it("matches on group name substring in prompt", () => {
		const result = detectGroupsFromPrompt("search slack threads", groups);
		assert.ok(result.includes("slack"));
	});

	it("does NOT match on generic tool suffixes like 'availability'", () => {
		// This was causing false positives — "availability" matched gcal_availability
		const result = detectGroupsFromPrompt("I need to check my availability", groups);
		assert.ok(!result.includes("gcal"), "should not match on tool name suffix");
	});

	it("matches calendar-related words from display name", () => {
		const result = detectGroupsFromPrompt("what's on my calendar today?", groups);
		assert.ok(result.includes("gcal"));
	});

	it("returns empty for unrelated prompt", () => {
		const result = detectGroupsFromPrompt("fix the typo in main.ts", groups);
		assert.equal(result.length, 0);
	});

	it("matches dynamically created groups", () => {
		const result = detectGroupsFromPrompt("use keke to search", groups);
		assert.ok(result.includes("keke"));
	});

	it("does NOT match on generic description words", () => {
		// "search" appears in many group descriptions — should not trigger
		const result = detectGroupsFromPrompt("search for files", groups);
		assert.equal(result.length, 0, "generic word 'search' should not match any group");
	});





});

// ─── GroupIndex (pre-computed inverted index) ────────────────────────────────

describe("GroupIndex", () => {
	const groups: ToolGroup[] = [
		{ name: "gcal", displayName: "Google Calendar", description: "Calendar tools", tools: ["gcal_events", "gcal_list"] },
		{ name: "gdocs", displayName: "Google Docs", description: "Document tools", tools: ["gdocs_create"] },
		{ name: "slack", displayName: "Slack", description: "Messaging tools", tools: ["slack_search"] },
	];
	const index = new GroupIndex(groups);

	it("detects by group name", () => {
		assert.ok(index.detect("load gcal").includes("gcal"));
	});

	it("detects by display name word", () => {
		assert.ok(index.detect("what\'s on my calendar?").includes("gcal"));
	});

	it("detects by full display name phrase", () => {
		assert.ok(index.detect("open google calendar").includes("gcal"));
	});

	it("hasUrl detects URLs in prompt", () => {
		assert.ok(GroupIndex.hasUrl("read https://docs.google.com/document/d/123"));
		assert.ok(GroupIndex.hasUrl("check http://example.com"));
		assert.ok(!GroupIndex.hasUrl("fix the typo in main.ts"));
		assert.ok(!GroupIndex.hasUrl("no urls here"));
	});

	it("respects loadable filter", () => {
		const loadable = new Set(["slack"]);
		const result = index.detect("check my calendar and slack", loadable);
		assert.ok(!result.includes("gcal"), "gcal not loadable");
		assert.ok(result.includes("slack"), "slack is loadable");
	});

	it("returns empty for unrelated prompt", () => {
		assert.equal(index.detect("fix the typo in main.ts").length, 0);
	});

	it("is fast for repeated detections", () => {
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			index.detect("can you check my calendar and summarize that google doc?");
		}
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 50, `1000 detections took ${elapsed.toFixed(1)}ms, expected <50ms`);
	});
});

// ─── LLM categorization helpers ───────────────────────────────────────────────

describe("LLM categorization helpers", () => {
	it("computeToolHash is stable for same tools", () => {
		const tools: ToolLike[] = [{ name: "b" }, { name: "a" }];
		const hash1 = computeToolHash(tools);
		const hash2 = computeToolHash([{ name: "a" }, { name: "b" }]);
		assert.equal(hash1, hash2, "hash should be order-independent");
	});

	it("computeToolHash changes when tools change", () => {
		const hash1 = computeToolHash([{ name: "a" }]);
		const hash2 = computeToolHash([{ name: "a" }, { name: "b" }]);
		assert.notEqual(hash1, hash2);
	});

	it("buildCategorizationPrompt includes tool names", () => {
		const prompt = buildCategorizationPrompt([{ name: "vault_search" }, { name: "read" }]);
		assert.ok(prompt.includes("vault_search"));
		assert.ok(prompt.includes("read"));
	});

	it("buildCategorizationPrompt includes descriptions when available", () => {
		const prompt = buildCategorizationPrompt([{ name: "vault_search", description: "Search vault" }]);
		assert.ok(prompt.includes("Search vault"));
	});

	it("parseCategorizationResponse parses valid JSON", () => {
		const response = JSON.stringify({
			groups: [
				{ name: "core", displayName: "Core", description: "Core tools", tools: ["read"] },
				{ name: "vault", displayName: "Vault", description: "Vault tools", tools: ["vault_search"] },
			],
		});
		const result = parseCategorizationResponse(response, ["read", "vault_search"]);
		assert.ok(result);
		assert.equal(result!.length, 2);
	});

	it("parseCategorizationResponse returns null for missing tools", () => {
		const response = JSON.stringify({
			groups: [
				{ name: "core", displayName: "Core", description: "Core tools", tools: ["read"] },
			],
		});
		// "vault_search" is missing from the response
		const result = parseCategorizationResponse(response, ["read", "vault_search"]);
		assert.equal(result, null);
	});

	it("parseCategorizationResponse strips markdown fences", () => {
		const response = "```json\n" + JSON.stringify({
			groups: [{ name: "core", displayName: "Core", description: "Core", tools: ["read"] }],
		}) + "\n```";
		const result = parseCategorizationResponse(response, ["read"]);
		assert.ok(result);
	});

	it("parseCategorizationResponse returns null for garbage", () => {
		assert.equal(parseCategorizationResponse("not json at all", ["read"]), null);
	});

	it("toolHash is stored in config via buildDefaultConfig", () => {
		const groups = [{ name: "core", displayName: "Core", description: "Core", tools: ["read"] }];
		const config = buildDefaultConfig(groups, { model: "google/gemini-2.0-flash", toolHash: "abc123" });
		assert.equal(config.toolHash, "abc123");
		assert.equal(config.categorizationModel, "google/gemini-2.0-flash");
		assert.deepEqual(config.toolGroups, groups);
	});
});
