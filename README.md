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
pi install git:github.com/marcuskbra/pi-lazy-tools
```

This is a fork of `ashwin-shopify/pi-lazy-tools` that adds durable group modes, a passthrough for spawned agents, and a config-driven categorization prompt. See "Durability and spawned agents" below.

## Usage

### First Run

On first session start, the extension prompts you to configure tool groups. Or accept the default (core always-on, everything else on-demand).

<img width="465" height="430" alt="image" src="https://github.com/user-attachments/assets/14e444a0-7c09-49e7-b658-e19d0160e257" />


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
  },
  "preserveModesBySignature": true,
  "passthrough": {
    "enabled": true,
    "modes": ["rpc", "json", "print"],
    "envMarkers": ["PI_TEAM_ROLE"]
  },
  "categorization": { "minGroups": 8, "maxGroups": 12 }
}
```

## Durability and spawned agents

Three opt-in settings live in the same `lazy-tools.json`. They default off, so
behaviour is unchanged until you enable them. The config file is not touched by
package updates, and a spawned teammate reads the same file, so enabling a
setting once carries across updates and into every child pi process.

### preserveModesBySignature

Group modes are stored under the LLM's group name. When the installed tool set
changes, the extension re-runs the categorization LLM, which may rename a
cluster (for example `team_management` becomes `team`). A rename used to drop
your `always` choice back to `on-demand`. With `preserveModesBySignature: true`,
a re-categorized group inherits the mode of the old group its tools most came
from, so `always` survives renames.

### passthrough

pi has no native notion of a subagent. A team teammate is just a child pi
process reading this same config, and this extension's tool filtering would
strip the `team_message` and `team_shutdown` tools the teammate needs to report
back and shut down. With `passthrough.enabled: true`, the extension stops
filtering when either the run mode is in `modes` (a pi-native signal covering
RPC and one-shot runs) or one of `envMarkers` is present in the environment
(covering pane-spawned teammates, which run as ordinary `tui` sessions and are
only identifiable by the role marker their spawner injects). Add other spawner
markers, such as a future `PI_SUBAGENT`, to `envMarkers` without a code change.

### categorization

The group-count target and grouping guidance handed to the categorization LLM.
`minGroups`/`maxGroups` default to 8 and 12; set them lower for fewer, broader
groups. `guidance` overrides the default "one service per group" bullets.

## Development

```bash
pnpm install
pnpm test
```
