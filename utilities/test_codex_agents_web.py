import importlib.util
import json
import sqlite3
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path


UTILITY_PATH = Path(__file__).with_name("codex-agents")
LOADER = SourceFileLoader("codex_agents_for_web_tests", str(UTILITY_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
codex_agents = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(codex_agents)

from codex_agents_web import Organizer, read_messages  # noqa: E402


class OrganizerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.organizer_database = self.root / "organizer.sqlite3"
        self.native_database = self.root / "state_5.sqlite"
        self.rollouts = self.root / "sessions"
        self.rollouts.mkdir()
        self.create_native_database()
        lifecycle = sqlite3.connect(self.organizer_database)
        lifecycle.row_factory = sqlite3.Row
        codex_agents.initialize_schema(lifecycle)
        lifecycle.close()
        self.organizer = Organizer(self.organizer_database, self.native_database)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def create_native_database(self) -> None:
        connection = sqlite3.connect(self.native_database)
        connection.executescript(
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                title TEXT NOT NULL,
                preview TEXT NOT NULL DEFAULT '',
                cwd TEXT NOT NULL,
                model TEXT,
                source TEXT NOT NULL,
                thread_source TEXT DEFAULT 'user',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE thread_spawn_edges (
                parent_thread_id TEXT NOT NULL,
                child_thread_id TEXT NOT NULL PRIMARY KEY,
                status TEXT NOT NULL
            );
            """
        )
        connection.close()

    def add_thread(
        self,
        thread_id: str,
        title: str,
        created_at: int,
        parent_id: str | None = None,
        cwd: str = "/tmp/example",
    ) -> Path:
        rollout = self.rollouts / f"{thread_id}.jsonl"
        records = [
            {
                "type": "event_msg",
                "payload": {"type": "user_message", "message": f"Question about {title}"},
            },
            {
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": f"Answer for {title}"},
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "input": "{}",
                    "status": "completed",
                },
            },
        ]
        rollout.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        connection = sqlite3.connect(self.native_database)
        connection.execute(
            """
            INSERT INTO threads (
                id, rollout_path, title, preview, cwd, model, source, thread_source,
                created_at, updated_at, archived, has_user_event
            ) VALUES (?, ?, ?, ?, ?, 'gpt-test', 'cli', ?, ?, ?, 0, 0)
            """,
            (
                thread_id,
                str(rollout),
                title,
                f"Preview of {title}" if title else "",
                cwd,
                "subagent" if parent_id else "user",
                created_at,
                created_at,
            ),
        )
        if parent_id:
            connection.execute(
                "INSERT INTO thread_spawn_edges VALUES (?, ?, 'completed')",
                (parent_id, thread_id),
            )
        connection.commit()
        connection.close()
        return rollout

    def test_first_sync_indexes_history_without_filling_inbox(self) -> None:
        self.add_thread("historical", "Historical work", int(time.time()) - 100)

        result = self.organizer.sync_catalog()
        snapshot = self.organizer.snapshot()

        self.assertTrue(result["first_sync"])
        self.assertEqual(snapshot["counts"]["catalog"], 1)
        self.assertEqual(snapshot["cards"], [])

    def test_new_top_level_thread_enters_inbox_but_subagent_does_not(self) -> None:
        self.organizer.sync_catalog()
        future = int(time.time()) + 2
        self.add_thread("parent", "New top-level work", future)
        self.add_thread("child", "Delegated research", future, parent_id="parent")

        snapshot = self.organizer.snapshot()

        self.assertEqual([card["thread_id"] for card in snapshot["cards"]], ["parent"])
        inbox = next(zone for zone in snapshot["zones"] if zone["system_kind"] == "inbox")
        self.assertEqual(snapshot["cards"][0]["zone_id"], inbox["zone_id"])

    def test_thread_enters_inbox_when_its_title_arrives(self) -> None:
        self.organizer.sync_catalog()
        created_at = int(time.time()) + 2
        self.add_thread("empty-start", "", created_at)
        self.organizer.sync_catalog()
        self.assertEqual(self.organizer.snapshot()["cards"], [])

        native = sqlite3.connect(self.native_database)
        native.execute(
            """
            UPDATE threads
            SET title = 'A newly opened session', preview = 'The first user prompt'
            WHERE id = 'empty-start'
            """
        )
        native.commit()
        native.close()

        cards = self.organizer.snapshot()["cards"]
        self.assertEqual([card["thread_id"] for card in cards], ["empty-start"])

    def test_user_thread_does_not_depend_on_has_user_event(self) -> None:
        self.organizer.sync_catalog()
        self.add_thread("zero-user-event", "A normal Codex thread", int(time.time()) + 2)

        cards = self.organizer.snapshot()["cards"]

        self.assertEqual([card["thread_id"] for card in cards], ["zero-user-event"])

    def test_board_is_newest_first_with_pinned_threads_above_inbox(self) -> None:
        self.organizer.sync_catalog()
        now = int(time.time())
        self.add_thread("older", "Older thread", now + 1)
        self.add_thread("newer", "Newer thread", now + 2)

        cards = self.organizer.snapshot()["cards"]
        self.assertEqual([card["thread_id"] for card in cards], ["newer", "older"])

        pinned = self.organizer.update_card("older", {"pinned": True})
        cards = self.organizer.snapshot()["cards"]

        self.assertIsNotNone(pinned["pinned_at"])
        self.assertEqual([card["thread_id"] for card in cards], ["older", "newer"])

    def test_projects_are_counted_and_filter_all_threads_by_working_directory(self) -> None:
        self.add_thread("config-one", "Config work", 1, cwd="/repos/config")
        self.add_thread("config-two", "More config work", 2, cwd="/repos/config")
        self.add_thread("erp-one", "ERP work", 3, cwd="/repos/champion-force")

        snapshot = self.organizer.snapshot()
        projects = {project["cwd"]: project["thread_count"] for project in snapshot["projects"]}
        filtered = self.organizer.list_threads(cwd="/repos/config")

        self.assertEqual(projects, {"/repos/champion-force": 1, "/repos/config": 2})
        self.assertEqual(
            [thread["thread_id"] for thread in filtered], ["config-two", "config-one"]
        )

    def test_legacy_null_thread_source_is_cataloged(self) -> None:
        self.add_thread("legacy-source", "An older saved thread", int(time.time()) - 10)
        native = sqlite3.connect(self.native_database)
        native.execute("UPDATE threads SET thread_source = NULL WHERE id = 'legacy-source'")
        native.commit()
        native.close()

        result = self.organizer.sync_catalog()

        self.assertTrue(result["available"])
        detail = self.organizer.thread_detail("legacy-source")
        self.assertEqual(detail["thread_source"], "")

    def test_work_item_hides_attached_thread_and_restores_it_on_detach(self) -> None:
        self.add_thread("thread-one", "Related investigation", int(time.time()) - 10)
        self.organizer.sync_catalog()
        self.organizer.promote_thread("thread-one")
        work_item = self.organizer.create_work_item("Fix the whole workflow")

        self.organizer.attach_thread(work_item["card_id"], "thread-one")
        grouped = self.organizer.snapshot()["cards"]
        self.assertEqual([card["card_type"] for card in grouped], ["work_item"])
        self.assertEqual(grouped[0]["threads"][0]["thread_id"], "thread-one")

        self.organizer.detach_thread(work_item["card_id"], "thread-one")
        restored = self.organizer.snapshot()["cards"]
        self.assertEqual({card["card_type"] for card in restored}, {"thread", "work_item"})

    def test_independent_task_can_keep_a_project_without_a_thread(self) -> None:
        task = self.organizer.create_work_item(
            "Prepare the rollout", project_cwd="/repos/champion-force"
        )

        self.assertEqual(task["cwd"], "/repos/champion-force")
        self.assertEqual(task["threads"], [])
        self.assertEqual(task["preview"], "No Codex threads linked yet.")
        projects = self.organizer.snapshot()["projects"]
        self.assertIn("/repos/champion-force", [project["cwd"] for project in projects])
        self.assertEqual(projects[0]["task_count"], 1)

    def test_thread_library_works_before_lifecycle_hooks_create_tables(self) -> None:
        lifecycle = sqlite3.connect(self.organizer_database)
        lifecycle.execute("DROP TABLE agents")
        lifecycle.execute("DROP TABLE sessions")
        lifecycle.commit()
        lifecycle.close()
        self.add_thread("first-run", "First run", 1)

        threads = self.organizer.list_threads()

        self.assertEqual(threads[0]["operational"]["state"], "unknown")

    def test_any_task_can_link_additional_threads(self) -> None:
        self.add_thread("primary", "Original conversation", 1, cwd="/repos/config")
        self.add_thread("follow-up", "Follow-up conversation", 2, cwd="/repos/config")
        self.organizer.sync_catalog()
        self.organizer.promote_thread("primary")

        task = self.organizer.attach_thread("primary", "follow-up")

        self.assertEqual(
            [thread["thread_id"] for thread in task["threads"]],
            ["primary", "follow-up"],
        )
        self.assertTrue(task["threads"][0]["primary"])

    def test_project_order_and_collapsed_state_are_persisted(self) -> None:
        self.add_thread("config", "Config", 1, cwd="/repos/config")
        self.add_thread("erp", "ERP", 2, cwd="/repos/erp")
        self.organizer.sync_catalog()

        self.organizer.reorder_projects(["/repos/erp", "/repos/config"])
        self.organizer.update_project("/repos/erp", {"collapsed": True})
        projects = self.organizer.snapshot()["projects"]

        self.assertEqual([project["cwd"] for project in projects], ["/repos/erp", "/repos/config"])
        self.assertEqual(projects[0]["collapsed"], 1)

    def test_card_annotations_and_tags_are_persisted(self) -> None:
        self.add_thread("annotated", "Needs a better title", int(time.time()) - 10)
        self.organizer.sync_catalog()
        self.organizer.promote_thread("annotated")

        result = self.organizer.update_card(
            "annotated",
            {
                "title_override": "Readable title",
                "note": "Remember the edge case.",
                "workflow_status": "waiting",
                "tags": ["ERP", "follow-up"],
            },
        )

        self.assertEqual(result["title"], "Readable title")
        self.assertEqual(result["workflow_status"], "waiting")
        self.assertEqual([tag["name"] for tag in result["tags"]], ["ERP", "follow-up"])

    def test_dismissed_thread_can_be_restored_from_all_threads(self) -> None:
        self.add_thread("dismissed", "A short-lived question", int(time.time()) - 10)
        self.organizer.sync_catalog()
        self.organizer.promote_thread("dismissed")
        self.organizer.update_card("dismissed", {"dismissed": True})

        self.assertEqual(self.organizer.snapshot()["cards"], [])
        library_thread = self.organizer.list_threads("short-lived")[0]
        self.assertIsNotNone(library_thread["dismissed_at"])

        self.organizer.promote_thread("dismissed")
        self.assertEqual(self.organizer.snapshot()["cards"][0]["thread_id"], "dismissed")

    def test_dismissing_a_thread_also_unpins_it(self) -> None:
        self.add_thread("pinned", "Pinned work", int(time.time()) - 10)
        self.organizer.sync_catalog()
        self.organizer.promote_thread("pinned")
        self.organizer.update_card("pinned", {"pinned": True})

        dismissed = self.organizer.update_card("pinned", {"dismissed": True})

        self.assertIsNone(dismissed["pinned_at"])
        self.assertIsNotNone(dismissed["dismissed_at"])

    def test_detail_and_full_text_index_use_conversation_events(self) -> None:
        rollout = self.add_thread("searchable", "Migration planning", int(time.time()) - 10)
        self.organizer.sync_catalog()

        self.assertEqual(
            read_messages(rollout),
            [
                {"role": "user", "text": "Question about Migration planning", "phase": ""},
                {"role": "assistant", "text": "Answer for Migration planning", "phase": ""},
            ],
        )
        detail = self.organizer.thread_detail("searchable")
        self.assertEqual(len(detail["messages"]), 2)
        self.assertEqual(detail["tools"][0]["name"], "exec_command")

        self.organizer._index_transcripts()
        results = self.organizer.list_threads("Migration")
        self.assertEqual([thread["thread_id"] for thread in results], ["searchable"])


if __name__ == "__main__":
    unittest.main()
