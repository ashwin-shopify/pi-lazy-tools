# ⚡ pi-lazy-tools

Reduce context window usage by **lazy-loading tool groups on demand** instead of shoving all 100+ tools into every prompt.

## The Problem

Pi loads ~109 tools into the system prompt at session start, consuming ~15% of a 250k context window before you even type a message. Most sessions only use a fraction of these tools.

## The Solution

This extension categorizes tools into groups and lets you choose which load immediately vs on-demand:

| Mode | Behavior | Context cost |
|------|----------|--------------|
| **always** | Loaded at session start | Full token cost |
| **on-demand** | Loaded when LLM calls `load_tools` or you use `/tools-load` | Zero until needed |
| **off** | Never loaded | Zero |

## Install

```bash
pi install git:github.com/ashwin-shopify/pi-lazy-tools
```

## Usage

### First Run

On first session start, the extension prompts you to configure tool groups. Or accept the default (core always-on, everything else on-demand).

### Commands

| Command | Description |
|---------|-------------|
| `/tools-setup` | Open the setup wizard to configure group modes |
| `/tools-load [group]` | Load an on-demand group for this session |
| `/tools-status` | Show current group status |

### Keyboard Shortcut

**Ctrl+Shift+T** — Quick-load a tool group via selector

### How the LLM Loads Tools

The system prompt tells the LLM which groups are available but inactive. When it needs one, it calls:

```
load_tools(groups: ["observe", "vault"])
```

This activates those groups for the rest of the session. The LLM only pays the token cost for tools it actually needs.

### CLI Flag

Disable lazy loading for a session:

```bash
pi --lazy false
```

## Tool Groups

Groups are auto-detected by tool name prefix:

| Group | Tools | Description |
|-------|-------|-------------|
| core | ~8 | read, write, edit, bash, ask, etc. (always on) |
| observe | ~21 | Logs, metrics, traces, error groups |
| vault | ~30 | People, teams, projects, missions, pages |
| buildkite | ~9 | CI/CD builds, jobs, pipelines |
| slack | ~8 | Search, threads, channels, DMs |
| data_portal | ~6 | BigQuery queries, dashboards |
| gcal | ~4 | Calendar events, availability |
| grokt | ~4 | Code search across repos |
| gdoc | ~3 | Google Docs create/edit |
| gmail | ~2 | Email read/manage |
| memory | ~5 | Persistent memory bank |
| superpowers | ~2 | Skills and subagent dispatch |

## Config

Saved to `~/.pi/agent/lazy-tools.json`:

```json
{
  "version": 1,
  "groups": {
    "core": "always",
    "memory": "always",
    "observe": "on-demand",
    "vault": "on-demand",
    "slack": "on-demand",
    "buildkite": "off"
  }
}
```

## Typical Context Savings

| Scenario | Before | After |
|----------|--------|-------|
| Session start | ~39k tokens (15.6%) | ~8-12k tokens (~4%) |
| After loading 2 groups | — | ~18-22k tokens (~8%) |
| Full session (all loaded) | ~39k tokens | ~39k tokens + gateway overhead |
