# Codex

## Agent status dashboard

`codex-agents` records lifecycle metadata from Codex hooks in a small SQLite
database and displays the current sessions and subagents in the terminal. It
does not store prompts, assistant messages, tool input, tool output, or
transcript contents.

Link the utility somewhere on `PATH`:

```sh
ln -s "$(pwd)/utilities/codex-agents" ~/.local/bin/codex-agents
```

Then link the global hook configuration:

```sh
ln -s "$(pwd)/codex/hooks.json" ~/.codex/hooks.json
```

If `~/.codex/hooks.json` already exists, merge the event handlers from
`codex/hooks.json` into it instead of replacing the file. Do not configure the
same handlers both in `hooks.json` and inline in `config.toml`.

Open `/hooks` in Codex to review and trust the hook definitions. New or changed
hook definitions are skipped until they have been trusted.

Start the dashboard:

```sh
codex-agents watch
```

Other useful views:

```sh
codex-agents list
codex-agents events --follow
codex-agents json
codex-agents clean
```

By default, state is stored at:

```text
${XDG_STATE_HOME:-~/.local/state}/codex-agents/status.sqlite3
```

Set `CODEX_AGENTS_DB` to use another database path. Set
`CODEX_AGENTS_DEBUG=1` to record hook ingestion errors in `debug.log` next to
the database.

Codex exposes explicit start and stop hooks for subagents, but regular tool
hooks do not include an explicit subagent ID. The dashboard therefore reports
reliable lifecycle state rather than attempting to infer the exact tool an
individual subagent is currently running. A working or waiting entry with no
updates for six hours is displayed as stale.
