# ⚡ pi-lazy-tools

Lazy-load tool groups on demand in [pi](https://github.com/badlogic/pi) to save context window tokens.

## Why

When you install many pi extensions (Observe, Vault, Slack, Buildkite, etc.), each one registers tools that are included in every system prompt. If you have 80-100+ tools, this can use a meaningful chunk of your context window before you type anything.

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

| Group | Description |
|-------|-------------|
| core | read, write, edit, bash, ask, etc. (always on) |
| observe | Logs, metrics, traces, error groups |
| vault | People, teams, projects, missions, pages |
| bk | CI/CD builds, jobs, pipelines |
| slack | Search, threads, channels, DMs |
| data_portal | BigQuery queries, dashboards |
| gcal | Calendar events, availability |
| grokt | Code search across repos |
| memory | Persistent memory bank |
| superpowers | Skills and subagent dispatch |

Actual groups and tool counts depend on what extensions you have installed.

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

## Development

```bash
pnpm install
pnpm test
```
