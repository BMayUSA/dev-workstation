import argparse
import importlib.util
import os
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("codex-agents")
LOADER = SourceFileLoader("codex_agents", str(MODULE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
codex_agents = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(codex_agents)


class QuitScreen:
    def timeout(self, _milliseconds: int) -> None:
        pass

    def getch(self) -> int:
        return ord("q")


class StaleReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_directory.name) / "status.sqlite3"
        self.environment = mock.patch.dict(
            os.environ,
            {"CODEX_AGENTS_DB": str(self.database)},
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temp_directory.cleanup()

    def create_active_session(self, session_id: str, agent_id: str) -> None:
        codex_agents.ingest_payload(
            {
                "hook_event_name": "SessionStart",
                "session_id": session_id,
                "cwd": "/tmp/example",
                "source": "startup",
            }
        )
        codex_agents.ingest_payload(
            {
                "hook_event_name": "SubagentStart",
                "session_id": session_id,
                "agent_id": agent_id,
                "agent_type": "worker",
                "cwd": "/tmp/example",
            }
        )

    def age_session(self, session_id: str, updated_at: float) -> None:
        connection = codex_agents.connect_database()
        try:
            with connection:
                connection.execute(
                    "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
                    (updated_at, session_id),
                )
                connection.execute(
                    "UPDATE agents SET updated_at = ? WHERE session_id = ?",
                    (updated_at, session_id),
                )
        finally:
            connection.close()

    def set_session_updated_at(self, session_id: str, updated_at: float) -> None:
        connection = codex_agents.connect_database()
        try:
            with connection:
                connection.execute(
                    "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
                    (updated_at, session_id),
                )
        finally:
            connection.close()

    def states(self, session_id: str) -> tuple[str, str]:
        connection = codex_agents.connect_database()
        try:
            session_state = connection.execute(
                "SELECT state FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()["state"]
            agent_state = connection.execute(
                "SELECT state FROM agents WHERE session_id = ?",
                (session_id,),
            ).fetchone()["state"]
            return session_state, agent_state
        finally:
            connection.close()

    def test_clean_reconciles_only_state_older_than_cutoff(self) -> None:
        now = time.time()
        self.create_active_session("old", "old-agent")
        self.create_active_session("recent", "recent-agent")
        self.age_session("old", now - 7 * 60 * 60)
        self.age_session("recent", now - 5 * 60 * 60)

        arguments = argparse.Namespace(
            stale_hours=6,
            completed_hours=24,
            ended_days=7,
            events=1000,
        )
        with mock.patch("sys.stdout"):
            result = codex_agents.clean_command(arguments)

        self.assertEqual(result, 0)
        self.assertEqual(self.states("old"), ("ended", "abandoned"))
        self.assertEqual(self.states("recent"), ("working", "working"))

    def test_clean_can_reconcile_an_orphan_agent_in_a_recent_session(self) -> None:
        now = time.time()
        self.create_active_session("active", "orphan-agent")
        self.age_session("active", now - 7 * 60 * 60)
        self.set_session_updated_at("active", now)

        arguments = argparse.Namespace(
            stale_hours=6,
            completed_hours=24,
            ended_days=7,
            events=1000,
        )
        with mock.patch("sys.stdout"):
            codex_agents.clean_command(arguments)

        self.assertEqual(self.states("active"), ("working", "abandoned"))

    def test_watch_can_reconcile_once_at_startup(self) -> None:
        now = time.time()
        self.create_active_session("old", "old-agent")
        self.age_session("old", now - 7 * 60 * 60)
        arguments = argparse.Namespace(
            all=False,
            interval=0.1,
            reconcile_stale=True,
            stale_hours=6,
            full_path=False,
            cwd=None,
        )

        with (
            mock.patch.object(codex_agents.curses, "curs_set"),
            mock.patch.object(codex_agents.curses, "has_colors", return_value=False),
            mock.patch.object(codex_agents, "draw_dashboard"),
        ):
            codex_agents.watch_screen(QuitScreen(), arguments)

        self.assertEqual(self.states("old"), ("ended", "abandoned"))

    def test_watch_does_not_reconcile_without_opt_in(self) -> None:
        now = time.time()
        self.create_active_session("old", "old-agent")
        self.age_session("old", now - 7 * 60 * 60)
        arguments = argparse.Namespace(
            all=False,
            interval=0.1,
            reconcile_stale=False,
            stale_hours=6,
            full_path=False,
            cwd=None,
        )

        with (
            mock.patch.object(codex_agents.curses, "curs_set"),
            mock.patch.object(codex_agents.curses, "has_colors", return_value=False),
            mock.patch.object(codex_agents, "draw_dashboard"),
        ):
            codex_agents.watch_screen(QuitScreen(), arguments)

        self.assertEqual(self.states("old"), ("working", "working"))


if __name__ == "__main__":
    unittest.main()
