"""
SQLite storage layer for Tokimeter.

Stores all LLM calls persistently. Zero external dependencies — uses
Python's built-in sqlite3 module.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from .models import LLMCall, CostReport


class Store:
    """Thread-safe SQLite store for LLM call records."""

    def __init__(self, db_path: str | Path = "tokimeter.db"):
        self.db_path = str(db_path)
        self._local = threading.local()
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        """Each thread gets its own connection."""
        if not hasattr(self._local, "conn"):
            self._local.conn = sqlite3.connect(self.db_path)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS llm_calls (
                id TEXT PRIMARY KEY,
                timestamp REAL NOT NULL,
                provider TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                input_cost REAL NOT NULL DEFAULT 0,
                output_cost REAL NOT NULL DEFAULT 0,
                total_cost REAL NOT NULL DEFAULT 0,
                agent_name TEXT NOT NULL DEFAULT 'default',
                workflow TEXT NOT NULL DEFAULT 'default',
                customer TEXT NOT NULL DEFAULT '',
                latency_ms REAL NOT NULL DEFAULT 0,
                success INTEGER NOT NULL DEFAULT 1,
                error TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '{}'
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_timestamp ON llm_calls(timestamp)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_agent ON llm_calls(agent_name)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_model ON llm_calls(model)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workflow ON llm_calls(workflow)
        """)
        conn.commit()
        conn.close()

    def record_call(self, call: LLMCall):
        """Insert a single LLM call record."""
        conn = self._get_conn()
        conn.execute("""
            INSERT INTO llm_calls
                (id, timestamp, provider, model, input_tokens, output_tokens,
                 cached_tokens, input_cost, output_cost, total_cost,
                 agent_name, workflow, customer, latency_ms, success, error, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            call.id, call.timestamp, call.provider, call.model,
            call.input_tokens, call.output_tokens, call.cached_tokens,
            call.input_cost, call.output_cost, call.total_cost,
            call.agent_name, call.workflow, call.customer,
            call.latency_ms, int(call.success), call.error,
            json.dumps(call.tags),
        ))
        conn.commit()

    def record_calls(self, calls: list[LLMCall]):
        """Batch insert multiple LLM call records."""
        conn = self._get_conn()
        conn.executemany("""
            INSERT INTO llm_calls
                (id, timestamp, provider, model, input_tokens, output_tokens,
                 cached_tokens, input_cost, output_cost, total_cost,
                 agent_name, workflow, customer, latency_ms, success, error, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, [(
            c.id, c.timestamp, c.provider, c.model,
            c.input_tokens, c.output_tokens, c.cached_tokens,
            c.input_cost, c.output_cost, c.total_cost,
            c.agent_name, c.workflow, c.customer,
            c.latency_ms, int(c.success), c.error,
            json.dumps(c.tags),
        ) for c in calls])
        conn.commit()

    def get_calls(
        self,
        start_time: float = 0,
        end_time: float = 0,
        agent_name: str = "",
        workflow: str = "",
        model: str = "",
        customer: str = "",
        limit: int = 10000,
    ) -> list[LLMCall]:
        """Query LLM calls with optional filters."""
        conn = self._get_conn()
        conditions = []
        params = []

        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)
        if agent_name:
            conditions.append("agent_name = ?")
            params.append(agent_name)
        if workflow:
            conditions.append("workflow = ?")
            params.append(workflow)
        if model:
            conditions.append("model = ?")
            params.append(model)
        if customer:
            conditions.append("customer = ?")
            params.append(customer)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT * FROM llm_calls {where} ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(query, params).fetchall()
        return [self._row_to_call(r) for r in rows]

    def get_report(
        self,
        start_time: float = 0,
        end_time: float = 0,
    ) -> CostReport:
        """Generate an aggregated cost report for a time period."""
        conn = self._get_conn()
        conditions = []
        params = []

        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = conn.execute(f"SELECT * FROM llm_calls {where}", params).fetchall()

        report = CostReport(
            period_start=start_time,
            period_end=end_time or time.time(),
        )

        for row in rows:
            call = self._row_to_call(row)
            report.add_call(call)

        return report

    def get_total_cost(self, start_time: float = 0, end_time: float = 0) -> float:
        """Quick total cost query without loading all rows."""
        conn = self._get_conn()
        conditions = []
        params = []
        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        row = conn.execute(
            f"SELECT COALESCE(SUM(total_cost), 0) as total FROM llm_calls {where}",
            params,
        ).fetchone()
        return row["total"] or 0.0

    def get_daily_costs(self, start_time: float = 0, end_time: float = 0) -> dict[str, float]:
        """Get daily cost breakdown."""
        conn = self._get_conn()
        conditions = []
        params = []
        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = conn.execute(f"""
            SELECT
                strftime('%Y-%m-%d', timestamp, 'unixepoch') as day,
                SUM(total_cost) as cost
            FROM llm_calls {where}
            GROUP BY day ORDER BY day
        """, params).fetchall()
        return {row["day"]: round(row["cost"], 6) for row in rows}

    def count(self) -> int:
        """Total number of stored calls."""
        conn = self._get_conn()
        row = conn.execute("SELECT COUNT(*) as n FROM llm_calls").fetchone()
        return row["n"]

    def _row_to_call(self, row: sqlite3.Row) -> LLMCall:
        return LLMCall(
            id=row["id"],
            timestamp=row["timestamp"],
            provider=row["provider"],
            model=row["model"],
            input_tokens=row["input_tokens"],
            output_tokens=row["output_tokens"],
            cached_tokens=row["cached_tokens"],
            input_cost=row["input_cost"],
            output_cost=row["output_cost"],
            total_cost=row["total_cost"],
            agent_name=row["agent_name"],
            workflow=row["workflow"],
            customer=row["customer"],
            latency_ms=row["latency_ms"],
            success=bool(row["success"]),
            error=row["error"],
            tags=json.loads(row["tags"]),
        )

    def close(self):
        if hasattr(self._local, "conn"):
            self._local.conn.close()
            del self._local.conn
