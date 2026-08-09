## Setup

Link each utility from this directory to a location on your path. For example:

`ln -s $(pwd)/utilities/delegator ~/.local/bin/delegator`

`ln -s $(pwd)/utilities/codex-agents ~/.local/bin/codex-agents`

## Utilities

- `delegator` creates Git worktrees and tmux sessions for parallel work.
- `codex-agents` displays live Codex session and subagent lifecycle status.
  Run `codex-agents serve --open` for the local web workboard, which adds an
  Inbox, tiled zones, work items, tags, notes, transcript search, and
  conversation details without modifying Codex's own history database.
