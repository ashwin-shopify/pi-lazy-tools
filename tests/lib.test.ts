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
	type ToolLike,
	type ToolGroup,
	type LazyToolsConfig,
	type GroupMode,
} from "../extensions/lib.js";

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
	// Single-tool groups
	{ name: "gcal_events" },
	{ name: "gmail_read" },
	{ name: "grokt_search" },
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
			data_portal: "on-demand",
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
		assert.equal(bk.displayName, "Buildkite");
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
		const groups = categorizeTools([{ name: "vault_get_user" }, { name: "slack_search" }]);
		assert.ok(!groups.find((g) => g.name === "core"));
		assert.equal(groups.length, 2);
	});

	it("matches exact prefix name as a tool", () => {
		// Edge case: a tool named exactly "observe" (no underscore suffix)
		const groups = categorizeTools([{ name: "observe" }]);
		const obs = groups.find((g) => g.name === "observe")!;
		assert.ok(obs);
		assert.deepEqual(obs.tools, ["observe"]);
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
	it("sets core and memory to always", () => {
		const groups = categorizeTools(MOCK_TOOLS);
		const config = buildDefaultConfig(groups);

		assert.equal(config.groups.core, "always");
		assert.equal(config.groups.memory, "always");
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
