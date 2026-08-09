"""Local web organizer for Codex threads and agent lifecycle state."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sqlite3
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


WORKFLOW_STATUSES = ("open", "in_progress", "waiting", "paused", "done")
STATUS_LABELS = {
    "open": "Open",
    "in_progress": "In progress",
    "waiting": "Waiting",
    "paused": "Paused",
    "done": "Done",
}
OPERATIONAL_PRIORITY = {
    "waiting_for_approval": 0,
    "working": 1,
    "waiting_on_agents": 2,
    "compacting": 3,
    "idle": 4,
    "stale": 5,
    "done": 6,
    "abandoned": 7,
    "ended": 8,
}
STALE_AFTER_SECONDS = 6 * 60 * 60
ASSET_DIRECTORY = Path(__file__).resolve().with_name("codex-agents-web")


def native_database_path() -> Path:
    override = os.environ.get("CODEX_STATE_DB")
    if override:
        return Path(override).expanduser()
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    return codex_home.expanduser() / "state_5.sqlite"


def effective_operational_state(state: str, updated_at: float) -> str:
    if state in {
        "working",
        "waiting_for_approval",
        "waiting_on_agents",
        "compacting",
    } and time.time() - updated_at > STALE_AFTER_SECONDS:
        return "stale"
    return state


def initialize_organizer_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS organizer_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS thread_catalog (
            thread_id TEXT PRIMARY KEY,
            rollout_path TEXT NOT NULL DEFAULT '',
            native_title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            cwd TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            thread_source TEXT NOT NULL DEFAULT '',
            parent_thread_id TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            has_user_event INTEGER NOT NULL DEFAULT 0,
            inbox_candidate INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS thread_catalog_updated_idx
            ON thread_catalog(updated_at DESC);
        CREATE INDEX IF NOT EXISTS thread_catalog_parent_idx
            ON thread_catalog(parent_thread_id);

        CREATE TABLE IF NOT EXISTS zones (
            zone_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            position INTEGER NOT NULL DEFAULT 0,
            system_kind TEXT UNIQUE,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS organizer_cards (
            card_id TEXT PRIMARY KEY,
            card_type TEXT NOT NULL CHECK(card_type IN ('thread', 'work_item')),
            thread_id TEXT UNIQUE,
            title_override TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            workflow_status TEXT NOT NULL DEFAULT 'open'
                CHECK(workflow_status IN ('open','in_progress','waiting','paused','done')),
            zone_id INTEGER,
            position INTEGER NOT NULL DEFAULT 0,
            dismissed_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES thread_catalog(thread_id)
                ON DELETE CASCADE,
            FOREIGN KEY(zone_id) REFERENCES zones(zone_id)
                ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS organizer_cards_zone_idx
            ON organizer_cards(zone_id, position);

        CREATE TABLE IF NOT EXISTS work_item_threads (
            work_item_id TEXT NOT NULL,
            thread_id TEXT NOT NULL UNIQUE,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(work_item_id, thread_id),
            FOREIGN KEY(work_item_id) REFERENCES organizer_cards(card_id)
                ON DELETE CASCADE,
            FOREIGN KEY(thread_id) REFERENCES thread_catalog(thread_id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS organizer_tags (
            tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            color TEXT NOT NULL DEFAULT 'slate'
        );

        CREATE TABLE IF NOT EXISTS card_tags (
            card_id TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY(card_id, tag_id),
            FOREIGN KEY(card_id) REFERENCES organizer_cards(card_id)
                ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES organizer_tags(tag_id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS transcript_index_state (
            thread_id TEXT PRIMARY KEY,
            file_mtime_ns INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            indexed_at REAL NOT NULL,
            FOREIGN KEY(thread_id) REFERENCES thread_catalog(thread_id)
                ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(
            thread_id UNINDEXED,
            content,
            tokenize='unicode61'
        );
        """
    )
    catalog_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(thread_catalog)")
    }
    if "thread_source" not in catalog_columns:
        connection.execute(
            "ALTER TABLE thread_catalog ADD COLUMN thread_source TEXT NOT NULL DEFAULT ''"
        )
    if "inbox_candidate" not in catalog_columns:
        connection.execute(
            "ALTER TABLE thread_catalog ADD COLUMN inbox_candidate INTEGER NOT NULL DEFAULT 0"
        )
    connection.execute(
        """
        INSERT INTO zones (name, position, system_kind, created_at)
        SELECT 'Inbox', 0, 'inbox', ?
        WHERE NOT EXISTS (SELECT 1 FROM zones WHERE system_kind = 'inbox')
        """,
        (time.time(),),
    )


class Organizer:
    def __init__(self, database_path: Path, codex_database: Path | None = None):
        self.database_path = database_path
        self.codex_database = codex_database or native_database_path()
        self._sync_lock = threading.Lock()
        self._index_lock = threading.Lock()
        self._index_started = False
        self.index_status: dict[str, Any] = {
            "running": False,
            "indexed": 0,
            "total": 0,
            "error": "",
        }
        connection = self.connect()
        connection.close()

    def connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=2)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 2000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        initialize_organizer_schema(connection)
        return connection

    def sync_catalog(self) -> dict[str, Any]:
        with self._sync_lock:
            return self._sync_catalog()

    def _sync_catalog(self) -> dict[str, Any]:
        if not self.codex_database.exists():
            return {
                "available": False,
                "error": f"Codex state database not found at {self.codex_database}",
            }

        connection = self.connect()
        try:
            initialized = connection.execute(
                "SELECT value FROM organizer_meta WHERE key = 'initialized_at'"
            ).fetchone()
            first_sync = initialized is None
            initialized_at = time.time() if first_sync else float(initialized["value"])

            if not first_sync:
                candidate_backfill = connection.execute(
                    "SELECT 1 FROM organizer_meta WHERE key = 'inbox_candidate_backfill_v1'"
                ).fetchone()
                if not candidate_backfill:
                    with connection:
                        connection.execute(
                            """
                            UPDATE thread_catalog
                            SET inbox_candidate = 1
                            WHERE created_at > ?
                            """,
                            (initialized_at,),
                        )
                        connection.execute(
                            """
                            INSERT INTO organizer_meta (key, value)
                            VALUES ('inbox_candidate_backfill_v1', ?)
                            """,
                            (str(time.time()),),
                        )

            uri = f"file:{self.codex_database}?mode=ro"
            native = sqlite3.connect(uri, uri=True, timeout=2)
            native.row_factory = sqlite3.Row
            try:
                threads = native.execute(
                    """
                    SELECT id, rollout_path, title, preview, cwd,
                           COALESCE(model, '') AS model, source,
                           COALESCE(thread_source, '') AS thread_source,
                           created_at, updated_at, archived, has_user_event
                    FROM threads
                    """
                ).fetchall()
                edges = native.execute(
                    "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges"
                ).fetchall()
            finally:
                native.close()

            parent_by_child = {
                row["child_thread_id"]: row["parent_thread_id"] for row in edges
            }
            known_threads = {
                row["thread_id"]: bool(row["inbox_candidate"])
                for row in connection.execute(
                    "SELECT thread_id, inbox_candidate FROM thread_catalog"
                )
            }
            now = time.time()
            inbox_id = connection.execute(
                "SELECT zone_id FROM zones WHERE system_kind = 'inbox'"
            ).fetchone()["zone_id"]
            with connection:
                if first_sync:
                    connection.execute(
                        "INSERT INTO organizer_meta (key, value) VALUES ('initialized_at', ?)",
                        (str(initialized_at),),
                    )
                for row in threads:
                    parent_id = parent_by_child.get(row["id"])
                    connection.execute(
                        """
                        INSERT INTO thread_catalog (
                            thread_id, rollout_path, native_title, preview, cwd,
                            model, source, thread_source, parent_thread_id,
                            created_at, updated_at, archived, has_user_event,
                            inbox_candidate
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(thread_id) DO UPDATE SET
                            rollout_path = excluded.rollout_path,
                            native_title = excluded.native_title,
                            preview = excluded.preview,
                            cwd = excluded.cwd,
                            model = excluded.model,
                            source = excluded.source,
                            thread_source = excluded.thread_source,
                            parent_thread_id = excluded.parent_thread_id,
                            updated_at = excluded.updated_at,
                            archived = excluded.archived,
                            has_user_event = excluded.has_user_event
                        """,
                        (
                            row["id"], row["rollout_path"], row["title"], row["preview"],
                            row["cwd"], row["model"], row["source"],
                            row["thread_source"], parent_id,
                            row["created_at"], row["updated_at"], row["archived"],
                            row["has_user_event"],
                            0 if first_sync else 1,
                        ),
                    )
                    is_user_thread = row["thread_source"] == "user" or (
                        not row["thread_source"] and row["source"] == "cli"
                    )
                    has_visible_content = bool(row["title"].strip() or row["preview"].strip())
                    if (
                        not first_sync
                        and parent_id is None
                        and is_user_thread
                        and has_visible_content
                        and (known_threads.get(row["id"], True))
                    ):
                        connection.execute(
                            """
                            INSERT OR IGNORE INTO organizer_cards (
                                card_id, card_type, thread_id, zone_id, position,
                                created_at, updated_at
                            ) VALUES (?, 'thread', ?, ?, ?, ?, ?)
                            """,
                            (row["id"], row["id"], inbox_id, int(now * 1000), now, now),
                        )
                connection.execute(
                    """
                    INSERT INTO organizer_meta (key, value) VALUES ('last_native_sync_at', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (str(now),),
                )
            return {"available": True, "threads": len(threads), "first_sync": first_sync}
        finally:
            connection.close()

    def start_transcript_indexer(self) -> None:
        with self._index_lock:
            if self._index_started:
                return
            self._index_started = True
            threading.Thread(
                target=self._index_transcripts,
                name="codex-agents-transcript-index",
                daemon=True,
            ).start()

    def _index_transcripts(self) -> None:
        connection = self.connect()
        try:
            rows = connection.execute(
                """
                SELECT c.thread_id, c.rollout_path, i.file_mtime_ns, i.file_size
                FROM thread_catalog c
                LEFT JOIN transcript_index_state i ON i.thread_id = c.thread_id
                WHERE c.rollout_path <> ''
                ORDER BY c.updated_at DESC
                """
            ).fetchall()
            self.index_status.update(running=True, indexed=0, total=len(rows), error="")
            for index, row in enumerate(rows, start=1):
                path = Path(row["rollout_path"])
                try:
                    stat = path.stat()
                except OSError:
                    self.index_status["indexed"] = index
                    continue
                if (
                    row["file_mtime_ns"] == stat.st_mtime_ns
                    and row["file_size"] == stat.st_size
                ):
                    self.index_status["indexed"] = index
                    continue
                content = "\n".join(message["text"] for message in read_messages(path))
                with connection:
                    connection.execute(
                        "DELETE FROM transcript_search WHERE thread_id = ?", (row["thread_id"],)
                    )
                    connection.execute(
                        "INSERT INTO transcript_search (thread_id, content) VALUES (?, ?)",
                        (row["thread_id"], content),
                    )
                    connection.execute(
                        """
                        INSERT INTO transcript_index_state (
                            thread_id, file_mtime_ns, file_size, indexed_at
                        ) VALUES (?, ?, ?, ?)
                        ON CONFLICT(thread_id) DO UPDATE SET
                            file_mtime_ns = excluded.file_mtime_ns,
                            file_size = excluded.file_size,
                            indexed_at = excluded.indexed_at
                        """,
                        (row["thread_id"], stat.st_mtime_ns, stat.st_size, time.time()),
                    )
                self.index_status["indexed"] = index
                time.sleep(0.01)
        except Exception as error:
            self.index_status["error"] = f"{type(error).__name__}: {error}"
        finally:
            self.index_status["running"] = False
            connection.close()

    def snapshot(self, show_completed: bool = False) -> dict[str, Any]:
        sync = self.sync_catalog()
        connection = self.connect()
        try:
            zones = [dict(row) for row in connection.execute(
                "SELECT zone_id, name, position, system_kind FROM zones ORDER BY position, zone_id"
            )]
            tags = [dict(row) for row in connection.execute(
                "SELECT tag_id, name, color FROM organizer_tags ORDER BY name COLLATE NOCASE"
            )]
            where = "c.dismissed_at IS NULL"
            parameters: list[Any] = []
            if not show_completed:
                where += " AND c.workflow_status <> 'done'"
            rows = connection.execute(
                f"""
                SELECT c.*, t.native_title, t.preview, t.cwd, t.model,
                       t.updated_at AS thread_updated_at
                FROM organizer_cards c
                LEFT JOIN thread_catalog t ON t.thread_id = c.thread_id
                WHERE {where}
                  AND (c.card_type = 'work_item' OR NOT EXISTS (
                      SELECT 1 FROM work_item_threads w WHERE w.thread_id = c.thread_id
                  ))
                ORDER BY c.zone_id, c.position, c.created_at
                """,
                parameters,
            ).fetchall()
            cards = [self._card_json(connection, row) for row in rows]
            counts = dict(connection.execute(
                """
                SELECT
                    COUNT(*) AS catalog,
                    SUM(CASE WHEN parent_thread_id IS NULL THEN 1 ELSE 0 END) AS top_level
                FROM thread_catalog
                """
            ).fetchone())
            return {
                "zones": zones,
                "cards": cards,
                "tags": tags,
                "statuses": STATUS_LABELS,
                "counts": counts,
                "sync": sync,
                "index": dict(self.index_status),
            }
        finally:
            connection.close()

    def _card_json(self, connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        card = dict(row)
        card["title"] = card["title_override"] or card.get("native_title") or "Untitled work item"
        card["tags"] = [dict(tag) for tag in connection.execute(
            """
            SELECT t.tag_id, t.name, t.color
            FROM organizer_tags t JOIN card_tags ct ON ct.tag_id = t.tag_id
            WHERE ct.card_id = ? ORDER BY t.name COLLATE NOCASE
            """,
            (card["card_id"],),
        )]
        if card["card_type"] == "work_item":
            children = connection.execute(
                """
                SELECT t.thread_id, t.native_title, t.preview, t.cwd, t.updated_at
                FROM work_item_threads w
                JOIN thread_catalog t ON t.thread_id = w.thread_id
                WHERE w.work_item_id = ? ORDER BY w.position, t.updated_at DESC
                """,
                (card["card_id"],),
            ).fetchall()
            card["threads"] = [dict(child) for child in children]
            states = [self._operational_for(connection, child["thread_id"]) for child in children]
            card["operational"] = aggregate_operational(states)
            card["preview"] = card["note"] or (
                children[0]["preview"] if children else "No threads attached yet."
            )
            card["cwd"] = children[0]["cwd"] if children else ""
            card["thread_updated_at"] = max(
                (child["updated_at"] for child in children), default=card["updated_at"]
            )
        else:
            card["threads"] = []
            card["operational"] = self._operational_for(connection, card["thread_id"])
        return card

    def _operational_for(self, connection: sqlite3.Connection, thread_id: str) -> dict[str, Any]:
        session = connection.execute(
            "SELECT state, updated_at, last_event FROM sessions WHERE session_id = ?",
            (thread_id,),
        ).fetchone()
        agents = connection.execute(
            """
            SELECT agent_id, agent_type, state, updated_at, last_event
            FROM agents WHERE session_id = ? ORDER BY updated_at DESC
            """,
            (thread_id,),
        ).fetchall()
        states: list[str] = []
        if session:
            states.append(effective_operational_state(session["state"], session["updated_at"]))
        agent_json = []
        for agent in agents:
            item = dict(agent)
            item["state"] = effective_operational_state(item["state"], item["updated_at"])
            states.append(item["state"])
            agent_json.append(item)
        primary = min(states, key=lambda state: OPERATIONAL_PRIORITY.get(state, 99)) if states else "unknown"
        return {"state": primary, "states": states, "agents": agent_json}

    def list_threads(self, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        self.sync_catalog()
        connection = self.connect()
        try:
            transcript_ids: list[str] = []
            terms = re.findall(r"[\w.-]+", query, flags=re.UNICODE)
            if terms:
                match = " AND ".join(f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in terms)
                try:
                    transcript_ids = [row["thread_id"] for row in connection.execute(
                        "SELECT thread_id FROM transcript_search WHERE transcript_search MATCH ? LIMIT 250",
                        (match,),
                    )]
                except sqlite3.OperationalError:
                    transcript_ids = []

            clauses = ["t.parent_thread_id IS NULL"]
            parameters: list[Any] = []
            if query:
                like = f"%{query}%"
                metadata_clause = """
                    (t.native_title LIKE ? OR t.preview LIKE ? OR t.cwd LIKE ?
                     OR t.thread_id LIKE ? OR c.title_override LIKE ? OR c.note LIKE ?)
                """
                parameters.extend([like] * 6)
                if transcript_ids:
                    placeholders = ",".join("?" for _ in transcript_ids)
                    clauses.append(f"({metadata_clause} OR t.thread_id IN ({placeholders}))")
                    parameters.extend(transcript_ids)
                else:
                    clauses.append(metadata_clause)
            parameters.append(max(1, min(limit, 250)))
            rows = connection.execute(
                f"""
                SELECT t.*, c.card_id, c.title_override, c.workflow_status,
                       c.dismissed_at, w.work_item_id
                FROM thread_catalog t
                LEFT JOIN organizer_cards c ON c.thread_id = t.thread_id
                LEFT JOIN work_item_threads w ON w.thread_id = t.thread_id
                WHERE {' AND '.join(clauses)}
                ORDER BY t.updated_at DESC LIMIT ?
                """,
                parameters,
            ).fetchall()
            return [dict(row) | {
                "title": row["title_override"] or row["native_title"],
                "operational": self._operational_for(connection, row["thread_id"]),
            } for row in rows]
        finally:
            connection.close()

    def thread_detail(self, thread_id: str) -> dict[str, Any]:
        self.sync_catalog()
        connection = self.connect()
        try:
            row = connection.execute(
                """
                SELECT t.*, c.card_id, c.title_override, c.note,
                       c.workflow_status, c.zone_id, c.dismissed_at,
                       w.work_item_id
                FROM thread_catalog t
                LEFT JOIN organizer_cards c ON c.thread_id = t.thread_id
                LEFT JOIN work_item_threads w ON w.thread_id = t.thread_id
                WHERE t.thread_id = ?
                """,
                (thread_id,),
            ).fetchone()
            if not row:
                raise KeyError("Thread not found")
            result = dict(row)
            result["title"] = result["title_override"] or result["native_title"]
            result["operational"] = self._operational_for(connection, thread_id)
            result["subagents"] = [dict(child) for child in connection.execute(
                """
                SELECT thread_id, native_title, preview, updated_at
                FROM thread_catalog WHERE parent_thread_id = ? ORDER BY updated_at DESC
                """,
                (thread_id,),
            )]
            path = Path(result["rollout_path"])
            result["messages"] = read_messages(path) if path.exists() else []
            result["tools"] = read_tool_activity(path) if path.exists() else []
            return result
        finally:
            connection.close()

    def card_detail(self, card_id: str) -> dict[str, Any]:
        connection = self.connect()
        try:
            row = connection.execute(
                """
                SELECT c.*, t.native_title, t.preview, t.cwd, t.model,
                       t.updated_at AS thread_updated_at
                FROM organizer_cards c
                LEFT JOIN thread_catalog t ON t.thread_id = c.thread_id
                WHERE c.card_id = ?
                """,
                (card_id,),
            ).fetchone()
            if not row:
                raise KeyError("Card not found")
            return self._card_json(connection, row)
        finally:
            connection.close()

    def create_zone(self, name: str) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("Zone name is required")
        connection = self.connect()
        try:
            position = connection.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM zones").fetchone()[0]
            with connection:
                cursor = connection.execute(
                    "INSERT INTO zones (name, position, created_at) VALUES (?, ?, ?)",
                    (name, position, time.time()),
                )
            return {"zone_id": cursor.lastrowid, "name": name, "position": position}
        finally:
            connection.close()

    def create_work_item(self, title: str, zone_id: int | None = None) -> dict[str, Any]:
        title = title.strip()
        if not title:
            raise ValueError("Work item title is required")
        connection = self.connect()
        try:
            if zone_id is None:
                zone_id = connection.execute(
                    "SELECT zone_id FROM zones WHERE system_kind = 'inbox'"
                ).fetchone()[0]
            now = time.time()
            card_id = f"work-{uuid.uuid4()}"
            with connection:
                connection.execute(
                    """
                    INSERT INTO organizer_cards (
                        card_id, card_type, title_override, zone_id, position,
                        created_at, updated_at
                    ) VALUES (?, 'work_item', ?, ?, ?, ?, ?)
                    """,
                    (card_id, title, zone_id, int(now * 1000), now, now),
                )
            return self.card_detail(card_id)
        finally:
            connection.close()

    def promote_thread(self, thread_id: str) -> dict[str, Any]:
        self.sync_catalog()
        connection = self.connect()
        try:
            exists = connection.execute(
                "SELECT 1 FROM thread_catalog WHERE thread_id = ?", (thread_id,)
            ).fetchone()
            if not exists:
                raise KeyError("Thread not found")
            inbox_id = connection.execute(
                "SELECT zone_id FROM zones WHERE system_kind = 'inbox'"
            ).fetchone()[0]
            now = time.time()
            with connection:
                connection.execute(
                    """
                    INSERT INTO organizer_cards (
                        card_id, card_type, thread_id, zone_id, position,
                        created_at, updated_at, dismissed_at
                    ) VALUES (?, 'thread', ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(card_id) DO UPDATE SET dismissed_at = NULL, updated_at = excluded.updated_at
                    """,
                    (thread_id, thread_id, inbox_id, int(now * 1000), now, now),
                )
                connection.execute("DELETE FROM work_item_threads WHERE thread_id = ?", (thread_id,))
            return self.card_detail(thread_id)
        finally:
            connection.close()

    def update_card(self, card_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        allowed = {"title_override", "note", "workflow_status", "zone_id", "position", "dismissed"}
        unknown = set(changes) - allowed - {"tags"}
        if unknown:
            raise ValueError(f"Unsupported fields: {', '.join(sorted(unknown))}")
        if "workflow_status" in changes and changes["workflow_status"] not in WORKFLOW_STATUSES:
            raise ValueError("Invalid workflow status")
        assignments: list[str] = []
        parameters: list[Any] = []
        for field in ("title_override", "note", "workflow_status", "zone_id", "position"):
            if field in changes:
                assignments.append(f"{field} = ?")
                parameters.append(changes[field])
        if "dismissed" in changes:
            assignments.append("dismissed_at = ?")
            parameters.append(time.time() if changes["dismissed"] else None)
        assignments.append("updated_at = ?")
        parameters.append(time.time())
        parameters.append(card_id)
        connection = self.connect()
        try:
            with connection:
                cursor = connection.execute(
                    f"UPDATE organizer_cards SET {', '.join(assignments)} WHERE card_id = ?",
                    parameters,
                )
                if not cursor.rowcount:
                    raise KeyError("Card not found")
                if "tags" in changes:
                    self._replace_tags(connection, card_id, changes["tags"])
            return self.card_detail(card_id)
        finally:
            connection.close()

    def _replace_tags(self, connection: sqlite3.Connection, card_id: str, names: Any) -> None:
        if not isinstance(names, list):
            raise ValueError("Tags must be a list")
        clean_names = list(dict.fromkeys(str(name).strip() for name in names if str(name).strip()))
        connection.execute("DELETE FROM card_tags WHERE card_id = ?", (card_id,))
        for name in clean_names:
            connection.execute("INSERT OR IGNORE INTO organizer_tags (name) VALUES (?)", (name,))
            tag_id = connection.execute(
                "SELECT tag_id FROM organizer_tags WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO card_tags (card_id, tag_id) VALUES (?, ?)", (card_id, tag_id)
            )

    def attach_thread(self, work_item_id: str, thread_id: str) -> dict[str, Any]:
        connection = self.connect()
        try:
            work_item = connection.execute(
                "SELECT 1 FROM organizer_cards WHERE card_id = ? AND card_type = 'work_item'",
                (work_item_id,),
            ).fetchone()
            thread = connection.execute(
                "SELECT 1 FROM thread_catalog WHERE thread_id = ?", (thread_id,),
            ).fetchone()
            if not work_item or not thread:
                raise KeyError("Work item or thread not found")
            with connection:
                connection.execute("DELETE FROM work_item_threads WHERE thread_id = ?", (thread_id,))
                position = connection.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM work_item_threads WHERE work_item_id = ?",
                    (work_item_id,),
                ).fetchone()[0]
                connection.execute(
                    "INSERT INTO work_item_threads (work_item_id, thread_id, position) VALUES (?, ?, ?)",
                    (work_item_id, thread_id, position),
                )
            return self.card_detail(work_item_id)
        finally:
            connection.close()

    def detach_thread(self, work_item_id: str, thread_id: str) -> dict[str, Any]:
        connection = self.connect()
        try:
            with connection:
                cursor = connection.execute(
                    "DELETE FROM work_item_threads WHERE work_item_id = ? AND thread_id = ?",
                    (work_item_id, thread_id),
                )
                if not cursor.rowcount:
                    raise KeyError("Thread is not attached to this work item")
                card = connection.execute(
                    "SELECT card_id FROM organizer_cards WHERE thread_id = ?", (thread_id,)
                ).fetchone()
                if card:
                    connection.execute(
                        "UPDATE organizer_cards SET dismissed_at = NULL, updated_at = ? WHERE card_id = ?",
                        (time.time(), card["card_id"]),
                    )
                else:
                    inbox_id = connection.execute(
                        "SELECT zone_id FROM zones WHERE system_kind = 'inbox'"
                    ).fetchone()[0]
                    now = time.time()
                    connection.execute(
                        """
                        INSERT INTO organizer_cards (
                            card_id, card_type, thread_id, zone_id, position,
                            created_at, updated_at
                        ) VALUES (?, 'thread', ?, ?, ?, ?, ?)
                        """,
                        (thread_id, thread_id, inbox_id, int(now * 1000), now, now),
                    )
            return self.card_detail(thread_id)
        finally:
            connection.close()


def aggregate_operational(items: list[dict[str, Any]]) -> dict[str, Any]:
    states = [item["state"] for item in items if item.get("state") != "unknown"]
    primary = min(states, key=lambda state: OPERATIONAL_PRIORITY.get(state, 99)) if states else "unknown"
    counts: dict[str, int] = {}
    for state in states:
        counts[state] = counts.get(state, 0) + 1
    return {"state": primary, "counts": counts, "threads": items}


def read_messages(path: Path) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if '"type":"event_msg"' not in line and '"type": "event_msg"' not in line:
                    continue
                if not any(marker in line for marker in ('"user_message"', '"agent_message"')):
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = record.get("payload", {})
                event_type = payload.get("type")
                if event_type not in {"user_message", "agent_message"}:
                    continue
                text = payload.get("message")
                if not isinstance(text, str) or not text.strip():
                    continue
                messages.append({
                    "role": "user" if event_type == "user_message" else "assistant",
                    "text": text,
                    "phase": str(payload.get("phase", "")),
                })
    except OSError:
        return []
    return messages


def read_tool_activity(path: Path, limit: int = 200) -> list[dict[str, str]]:
    tools: list[dict[str, str]] = []
    outputs: dict[str, str] = {}
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if '"custom_tool_call"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "response_item":
                    continue
                payload = record.get("payload", {})
                kind = payload.get("type")
                call_id = str(payload.get("call_id", ""))
                if kind == "custom_tool_call_output":
                    outputs[call_id] = str(payload.get("output", ""))[:4000]
                elif kind == "custom_tool_call" and len(tools) < limit:
                    tools.append({
                        "call_id": call_id,
                        "name": str(payload.get("name", "tool")),
                        "input": str(payload.get("input", ""))[:4000],
                        "status": str(payload.get("status", "")),
                    })
    except OSError:
        return []
    for tool in tools:
        tool["output"] = outputs.get(tool["call_id"], "")
    return tools


class OrganizerHandler(BaseHTTPRequestHandler):
    organizer: Organizer

    def log_message(self, format_string: str, *args: Any) -> None:
        stamp = datetime.now().astimezone().strftime("%H:%M:%S")
        print(f"[{stamp}] {self.address_string()} {format_string % args}")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/state":
                query = parse_qs(parsed.query)
                self.send_json(self.organizer.snapshot(query.get("completed", ["0"])[0] == "1"))
                return
            if parsed.path == "/api/threads":
                query = parse_qs(parsed.query)
                self.send_json({"threads": self.organizer.list_threads(query.get("q", [""])[0])})
                return
            if parsed.path.startswith("/api/threads/"):
                thread_id = unquote(parsed.path.removeprefix("/api/threads/"))
                self.send_json(self.organizer.thread_detail(thread_id))
                return
            if parsed.path.startswith("/api/cards/"):
                card_id = unquote(parsed.path.removeprefix("/api/cards/"))
                self.send_json(self.organizer.card_detail(card_id))
                return
            self.send_asset(parsed.path)
        except KeyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:
            self.send_json({"error": f"{type(error).__name__}: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            body = self.read_json()
            if parsed.path == "/api/zones":
                self.send_json(self.organizer.create_zone(str(body.get("name", ""))), HTTPStatus.CREATED)
                return
            if parsed.path == "/api/work-items":
                self.send_json(self.organizer.create_work_item(
                    str(body.get("title", "")), body.get("zone_id")
                ), HTTPStatus.CREATED)
                return
            if parsed.path == "/api/cards/thread":
                self.send_json(self.organizer.promote_thread(str(body.get("thread_id", ""))))
                return
            match = re.fullmatch(r"/api/work-items/([^/]+)/threads", parsed.path)
            if match:
                self.send_json(self.organizer.attach_thread(
                    unquote(match.group(1)), str(body.get("thread_id", ""))
                ))
                return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, sqlite3.IntegrityError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except KeyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:
            self.send_json({"error": f"{type(error).__name__}: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_PATCH(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/cards/"):
                card_id = unquote(parsed.path.removeprefix("/api/cards/"))
                self.send_json(self.organizer.update_card(card_id, self.read_json()))
                return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, sqlite3.IntegrityError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except KeyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:
            self.send_json({"error": f"{type(error).__name__}: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/work-items/([^/]+)/threads/([^/]+)", parsed.path)
        try:
            if match:
                self.send_json(self.organizer.detach_thread(
                    unquote(match.group(1)), unquote(match.group(2))
                ))
                return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except KeyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:
            self.send_json({"error": f"{type(error).__name__}: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Request body is too large")
        if not length:
            return {}
        parsed = json.loads(self.rfile.read(length))
        if not isinstance(parsed, dict):
            raise ValueError("JSON object required")
        return parsed

    def send_json(self, value: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_asset(self, requested_path: str) -> None:
        relative = "index.html" if requested_path in {"", "/"} else requested_path.lstrip("/")
        path = (ASSET_DIRECTORY / relative).resolve()
        if ASSET_DIRECTORY.resolve() not in path.parents or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        payload = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)


def serve(database_path: Path, host: str, port: int, open_browser: bool = False) -> int:
    organizer = Organizer(database_path)
    organizer.sync_catalog()
    organizer.start_transcript_indexer()
    handler = type("BoundOrganizerHandler", (OrganizerHandler,), {"organizer": organizer})
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{server.server_port}"
    print(f"Codex Workboard is available at {url}")
    print(f"Organizer database: {database_path}")
    print("Press Ctrl-C to stop.")
    if open_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Codex Workboard.")
    finally:
        server.server_close()
    return 0
