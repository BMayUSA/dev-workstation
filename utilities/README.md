## Setup

Link each utility from this directory to a location on your path. For example:

`ln -s $(pwd)/utilities/delegator ~/.local/bin/delegator`

`ln -s $(pwd)/utilities/codex-agents ~/.local/bin/codex-agents`

## Utilities

- `delegator` creates Git worktrees and tmux sessions for parallel work.
- `codex-agents` displays live Codex session and subagent lifecycle status.
  Run `codex-agents serve --open` for the local task app. Tasks can stand alone
  or link to one or more Codex threads, and are organized by reorderable,
  collapsible projects, workflow status, labels, and notes. The thread library
  remains searchable without modifying Codex's own history database.
