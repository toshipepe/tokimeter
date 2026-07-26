"""
Backend abstraction layer for Tokimeter.

Supports two backends:
  1. SQLiteStore   — local, zero-config, for solo devs and development
  2. SupabaseStore — cloud Postgres, for teams and production

Both implement the same Backend protocol so the rest of the library
doesn't need to know which storage is in use.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.request
import urllib.error
from typing import Any, Optional, Protocol

from .models import LLMCall, CostReport


# ─── Backend Protocol ────────────────────────────────────────────────────────


class Backend(Protocol):
    """Storage backend interface — all backends implement this."""

    def record_call(self, call: LLMCall) -> None: ...
    def record_calls(self, calls: list[LLMCall]) -> None: ...
    def get_calls(self, **filters) -> list[LLMCall]: ...
    def get_report(self, start_time: float = 0, end_time: float = 0) -> CostReport: ...
    def get_total_cost(self, start_time: float = 0, end_time: float = 0) -> float: ...
    def count(self) -> int: ...
    def close(self) -> None: ...


# ─── SQLite Backend ──────────────────────────────────────────────────────────


class SQLiteStore:
    """Local SQLite storage — zero config, single file."""

    def __init__(self, db_path: str = "tokimeter.db"):
        self.db_path = str(db_path)
        self._local = threading.local()
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn"):
            self._local.conn = sqlite3.connect(self.db_path)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.executescript(self._schema_sql())
        conn.commit()
        conn.close()

    @staticmethod
    def _schema_sql() -> str:
        return """
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
            );
            CREATE INDEX IF NOT EXISTS idx_ts ON llm_calls(timestamp);
            CREATE INDEX IF NOT EXISTS idx_agent ON llm_calls(agent_name);
            CREATE INDEX IF NOT EXISTS idx_model ON llm_calls(model);
            CREATE INDEX IF NOT EXISTS idx_workflow ON llm_calls(workflow);
        """

    def record_call(self, call: LLMCall):
        conn = self._get_conn()
        conn.execute(self._insert_sql(), self._call_to_row(call))
        conn.commit()

    def record_calls(self, calls: list[LLMCall]):
        if not calls:
            return
        conn = self._get_conn()
        conn.executemany(self._insert_sql(), [self._call_to_row(c) for c in calls])
        conn.commit()

    @staticmethod
    def _insert_sql() -> str:
        return """
            INSERT OR IGNORE INTO llm_calls
                (id, timestamp, provider, model, input_tokens, output_tokens,
                 cached_tokens, input_cost, output_cost, total_cost,
                 agent_name, workflow, customer, latency_ms, success, error, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """

    @staticmethod
    def _call_to_row(call: LLMCall) -> tuple:
        return (
            call.id, call.timestamp, call.provider, call.model,
            call.input_tokens, call.output_tokens, call.cached_tokens,
            call.input_cost, call.output_cost, call.total_cost,
            call.agent_name, call.workflow, call.customer,
            call.latency_ms, int(call.success), call.error,
            json.dumps(call.tags),
        )

    def get_calls(self, start_time=0, end_time=0, agent_name="",
                  workflow="", model="", customer="", limit=10000) -> list[LLMCall]:
        conn = self._get_conn()
        conditions, params = self._build_filters(
            start_time, end_time, agent_name, workflow, model, customer
        )
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT * FROM llm_calls {where} ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        return [self._row_to_call(r) for r in rows]

    def get_report(self, start_time=0, end_time=0) -> CostReport:
        conn = self._get_conn()
        conditions, params = self._build_filters(start_time, end_time)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = conn.execute(f"SELECT * FROM llm_calls {where}", params).fetchall()
        report = CostReport(period_start=start_time, period_end=end_time or time.time())
        for row in rows:
            report.add_call(self._row_to_call(row))
        return report

    def get_total_cost(self, start_time=0, end_time=0) -> float:
        conn = self._get_conn()
        conditions, params = self._build_filters(start_time, end_time)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        row = conn.execute(
            f"SELECT COALESCE(SUM(total_cost), 0) as total FROM llm_calls {where}", params
        ).fetchone()
        return row["total"] or 0.0

    def get_daily_costs(self, start_time=0, end_time=0) -> dict[str, float]:
        conn = self._get_conn()
        conditions, params = self._build_filters(start_time, end_time)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = conn.execute(f"""
            SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch') as day,
                   SUM(total_cost) as cost
            FROM llm_calls {where}
            GROUP BY day ORDER BY day
        """, params).fetchall()
        return {row["day"]: round(row["cost"], 6) for row in rows}

    def count(self) -> int:
        conn = self._get_conn()
        return conn.execute("SELECT COUNT(*) as n FROM llm_calls").fetchone()["n"]

    @staticmethod
    def _build_filters(start_time=0, end_time=0, agent_name="",
                       workflow="", model="", customer="") -> tuple[list, list]:
        conditions, params = [], []
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
        return conditions, params

    @staticmethod
    def _row_to_call(row: sqlite3.Row) -> LLMCall:
        return LLMCall(
            id=row["id"], timestamp=row["timestamp"],
            provider=row["provider"], model=row["model"],
            input_tokens=row["input_tokens"], output_tokens=row["output_tokens"],
            cached_tokens=row["cached_tokens"],
            input_cost=row["input_cost"], output_cost=row["output_cost"],
            total_cost=row["total_cost"],
            agent_name=row["agent_name"], workflow=row["workflow"],
            customer=row["customer"],
            latency_ms=row["latency_ms"],
            success=bool(row["success"]), error=row["error"],
            tags=json.loads(row["tags"]),
        )

    def close(self):
        if hasattr(self._local, "conn"):
            self._local.conn.close()
            del self._local.conn


# ─── Supabase (Postgres REST) Backend ────────────────────────────────────────


class SupabaseStore:
    """
    Cloud Postgres storage via Supabase REST API.

    Zero SDK dependency — uses urllib to call the Supabase REST API directly.

    Setup:
        1. Create a free project at https://supabase.com
        2. Run the SQL from supabase_schema.sql in the SQL editor
        3. Set environment variables:
            TOKIMETER_SUPABASE_URL=https://xxx.supabase.co
            TOKIMETER_SUPABASE_KEY=eyJhbG...
        4. Or pass them directly:
            store = SupabaseStore(
                url="https://xxx.supabase.co",
                key="eyJhbG...",
            )
    """

    def __init__(
        self,
        url: str = "",
        key: str = "",
        table_name: str = "llm_calls",
    ):
        self.url = (url or os.environ.get("TOKIMETER_SUPABASE_URL", "")).rstrip("/")
        self.key = key or os.environ.get("TOKIMETER_SUPABASE_KEY", "")
        self.table = table_name

        if not self.url or not self.key:
            raise ValueError(
                "SupabaseStore requires a URL and API key. Set environment variables "
                "TOKIMETER_SUPABASE_URL and TOKIMETER_SUPABASE_KEY, or pass them directly.\n"
                "Get them from: https://app.supabase.com → Your Project → Settings → API"
            )

        self._base_url = f"{self.url}/rest/v1/{self.table}"
        self._headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }

    def _request(self, method: str, path: str = "", json_body: Any = None,
                 params: dict | None = None) -> Any:
        url = self._base_url + path
        if params:
            query_parts = []
            for k, v in params.items():
                query_parts.append(f"{k}={v}")
            url += "?" + "&".join(query_parts)

        data = json.dumps(json_body).encode() if json_body else None
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 204:
                    return None
                body = resp.read().decode()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else ""
            raise RuntimeError(
                f"Supabase API error {e.code}: {error_body[:500]}"
            ) from e

    def record_call(self, call: LLMCall):
        self._request("POST", json_body=self._call_to_dict(call))

    def record_calls(self, calls: list[LLMCall]):
        if not calls:
            return
        # Supabase supports bulk insert
        body = [self._call_to_dict(c) for c in calls]
        self._request("POST", json_body=body)

    @staticmethod
    def _call_to_dict(call: LLMCall) -> dict:
        return {
            "id": call.id,
            "timestamp": call.timestamp,
            "provider": call.provider,
            "model": call.model,
            "input_tokens": call.input_tokens,
            "output_tokens": call.output_tokens,
            "cached_tokens": call.cached_tokens,
            "input_cost": call.input_cost,
            "output_cost": call.output_cost,
            "total_cost": call.total_cost,
            "agent_name": call.agent_name,
            "workflow": call.workflow,
            "customer": call.customer,
            "latency_ms": call.latency_ms,
            "success": call.success,
            "error": call.error,
            "tags": json.dumps(call.tags),
        }

    @staticmethod
    def _dict_to_call(d: dict) -> LLMCall:
        tags = d.get("tags", "{}")
        if isinstance(tags, str):
            tags = json.loads(tags)
        return LLMCall(
            id=d["id"], timestamp=d["timestamp"],
            provider=d.get("provider", ""), model=d.get("model", ""),
            input_tokens=d.get("input_tokens", 0),
            output_tokens=d.get("output_tokens", 0),
            cached_tokens=d.get("cached_tokens", 0),
            input_cost=d.get("input_cost", 0),
            output_cost=d.get("output_cost", 0),
            total_cost=d.get("total_cost", 0),
            agent_name=d.get("agent_name", "default"),
            workflow=d.get("workflow", "default"),
            customer=d.get("customer", ""),
            latency_ms=d.get("latency_ms", 0),
            success=d.get("success", True),
            error=d.get("error", ""),
            tags=tags,
        )

    def get_calls(self, start_time=0, end_time=0, agent_name="",
                  workflow="", model="", customer="", limit=10000) -> list[LLMCall]:
        params: list[str] = [
            "select=*",
            f"limit={limit}",
        ]

        filters = []
        if start_time:
            filters.append(f"timestamp.gte.{start_time}")
        if end_time:
            filters.append(f"timestamp.lte.{end_time}")
        if agent_name:
            filters.append(f"agent_name=eq.{agent_name}")
        if workflow:
            filters.append(f"workflow=eq.{workflow}")
        if model:
            filters.append(f"model=eq.{model}")
        if customer:
            filters.append(f"customer=eq.{customer}")

        query_str = "&".join(params + [f"&{f}" for f in []])  # base params

        # Build URL properly
        url = f"{self._base_url}?select=*&limit={limit}&order=timestamp.desc"
        for f in filters:
            url += f"&{f}"

        req = urllib.request.Request(url, headers=self._headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                rows = json.loads(resp.read().decode())
                return [self._dict_to_call(r) for r in rows]
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Supabase query failed: {e.code} {e.read().decode()[:200]}") from e

    def get_report(self, start_time=0, end_time=0) -> CostReport:
        calls = self.get_calls(start_time=start_time, end_time=end_time, limit=100000)
        report = CostReport(period_start=start_time, period_end=end_time or time.time())
        for call in calls:
            report.add_call(call)
        return report

    def get_total_cost(self, start_time=0, end_time=0) -> float:
        report = self.get_report(start_time=start_time, end_time=end_time)
        return report.total_cost

    def count(self) -> int:
        url = f"{self._base_url}?select=id&limit=1&head=true"
        # Use Prefer: count=exact header
        headers = {**self._headers, "Prefer": "count=exact"}
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                # Content-Range header has the count: e.g. "0-0/12345"
                content_range = resp.headers.get("Content-Range", "*/0")
                total = content_range.split("/")[-1] if "/" in content_range else "0"
                return int(total)
        except (urllib.error.HTTPError, ValueError):
            return 0

    def close(self):
        pass  # No persistent connection to close


# ─── Factory ─────────────────────────────────────────────────────────────────


def create_backend(
    db_path: str = "",
    supabase_url: str = "",
    supabase_key: str = "",
) -> Backend:
    """
    Auto-detect and create the appropriate backend.

    Priority:
      1. If supabase_url/supabase_key provided (or env vars set) → Supabase
      2. If db_path provided → SQLite
      3. If TOKIMETER_SUPABASE_URL env var set → Supabase
      4. Otherwise → None (in-memory)
    """
    # Check for Supabase config
    sb_url = supabase_url or os.environ.get("TOKIMETER_SUPABASE_URL", "")
    sb_key = supabase_key or os.environ.get("TOKIMETER_SUPABASE_KEY", "")

    if sb_url and sb_key:
        return SupabaseStore(url=sb_url, key=sb_key)

    if db_path:
        return SQLiteStore(db_path)

    return None  # Caller should use in-memory mode
