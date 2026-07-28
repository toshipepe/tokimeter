"""
Hosted Tokimeter API scaffold.

This module is intentionally dependency-free so the project can run a hosted
prototype before choosing FastAPI/Next/etc. for the production app. It provides:
  - Tenant/project/API-key bootstrap
  - Hashed project API keys
  - Batched event ingestion
  - Tenant-scoped reports, recommendations, budgets, and basic subscription rows
"""

from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import io
import json
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .models import LLMCall, CostReport
from .optimizer import Optimizer
from .pricing import Pricer


DEFAULT_DB_PATH = "tokimeter_hosted.db"
API_KEY_PREFIX = "tmk_live_"


def utc_now() -> float:
    return time.time()


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict | list):
    body = json.dumps(payload, default=str).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def html_response(handler: BaseHTTPRequestHandler, status: int, html: str):
    body = html.encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def csv_response(handler: BaseHTTPRequestHandler, filename: str, csv_text: str):
    body = csv_text.encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/csv; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def error_response(handler: BaseHTTPRequestHandler, status: int, message: str):
    json_response(handler, status, {"error": message})


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


def new_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def normalize_event(event: dict, pricer: Pricer) -> LLMCall:
    provider = str(event.get("provider", ""))
    model = str(event.get("model", ""))
    input_tokens = int(event.get("input_tokens", event.get("inputTokens", 0)) or 0)
    output_tokens = int(event.get("output_tokens", event.get("outputTokens", 0)) or 0)
    cached_tokens = int(event.get("cached_tokens", event.get("cachedTokens", 0)) or 0)
    input_cost = float(event.get("input_cost", event.get("inputCost", 0)) or 0)
    output_cost = float(event.get("output_cost", event.get("outputCost", 0)) or 0)

    reported_total = float(event.get("total_cost", event.get("totalCost", 0)) or 0)

    tags = event.get("tags") or {}
    if not isinstance(tags, dict):
        tags = {"raw_tags": str(tags)}

    if input_cost == 0 and output_cost == 0 and reported_total == 0:
        source = pricer.get_price_source(model)
        input_cost, output_cost, total_cost = pricer.price_call(
            model, input_tokens, output_tokens, cached_tokens, provider
        )
        tags["pricing_source"] = source["source"]
        tags["pricing_authoritative"] = source["authoritative"]
        if not source["authoritative"]:
            _, _, rough = pricer.rough_estimate_call(input_tokens, output_tokens)
            tags["rough_estimate_cost"] = rough
    else:
        total_cost = reported_total or input_cost + output_cost
        tags["pricing_source"] = "reported"
        tags["pricing_authoritative"] = True

    return LLMCall(
        id=str(event.get("id") or uuid.uuid4()),
        timestamp=float(event.get("timestamp") or utc_now()),
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=cached_tokens,
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=total_cost,
        agent_name=str(event.get("agent_name", event.get("agentName", "default")) or "default"),
        workflow=str(event.get("workflow", "default") or "default"),
        customer=str(event.get("customer", "")),
        latency_ms=float(event.get("latency_ms", event.get("latencyMs", 0)) or 0),
        success=bool(event.get("success", True)),
        error=str(event.get("error", "")),
        tags=tags,
    )


class HostedStore:
    """SQLite-backed hosted SaaS data model for local production scaffolding."""

    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = str(db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.init_db()

    def init_db(self):
        self.conn.executescript(
            """
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS orgs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memberships (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'owner',
                created_at REAL NOT NULL,
                UNIQUE(org_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                environment TEXT NOT NULL DEFAULT 'production',
                created_at REAL NOT NULL,
                UNIQUE(org_id, slug)
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                prefix TEXT NOT NULL,
                last_used_at REAL,
                revoked_at REAL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS llm_calls (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                external_id TEXT,
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
                tags TEXT NOT NULL DEFAULT '{}',
                inserted_at REAL NOT NULL,
                UNIQUE(project_id, external_id)
            );

            CREATE TABLE IF NOT EXISTS budgets (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                limit_usd REAL NOT NULL,
                period TEXT NOT NULL DEFAULT 'monthly',
                agent_name TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                customer TEXT NOT NULL DEFAULT '',
                alert_at_pct REAL NOT NULL DEFAULT 80,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                plan TEXT NOT NULL DEFAULT 'free',
                status TEXT NOT NULL DEFAULT 'trialing',
                stripe_customer_id TEXT NOT NULL DEFAULT '',
                stripe_subscription_id TEXT NOT NULL DEFAULT '',
                current_period_end REAL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS alert_channels (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'log',
                target TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS alert_events (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                budget_id TEXT REFERENCES budgets(id) ON DELETE SET NULL,
                channel_id TEXT REFERENCES alert_channels(id) ON DELETE SET NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
                current_spend REAL NOT NULL DEFAULT 0,
                pct_used REAL NOT NULL DEFAULT 0,
                period_start REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                UNIQUE(budget_id, channel_id, period_start, severity)
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
                actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_llm_calls_org_ts ON llm_calls(org_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_llm_calls_project_ts ON llm_calls(project_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_llm_calls_agent ON llm_calls(org_id, agent_name);
            CREATE INDEX IF NOT EXISTS idx_llm_calls_model ON llm_calls(org_id, model);
            CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
            CREATE INDEX IF NOT EXISTS idx_alert_channels_org ON alert_channels(org_id);
            CREATE INDEX IF NOT EXISTS idx_alert_events_org_ts ON alert_events(org_id, created_at);
            """
        )
        self.conn.commit()

    def bootstrap(self, org_name: str, user_email: str, project_name: str) -> dict:
        now = utc_now()
        org_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())
        membership_id = str(uuid.uuid4())
        subscription_id = str(uuid.uuid4())
        api_key_id = str(uuid.uuid4())
        raw_key = new_api_key()

        org_slug = slugify(org_name)
        project_slug = slugify(project_name)

        self.conn.execute(
            "INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
            (org_id, org_name, org_slug, now),
        )
        self.conn.execute(
            "INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
            (user_id, user_email, "", now),
        )
        self.conn.execute(
            "INSERT INTO memberships (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
            (membership_id, org_id, user_id, "owner", now),
        )
        self.conn.execute(
            """
            INSERT INTO projects (id, org_id, name, slug, environment, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, org_id, project_name, project_slug, "production", now),
        )
        self.conn.execute(
            """
            INSERT INTO api_keys (id, org_id, project_id, name, key_hash, prefix, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                api_key_id,
                org_id,
                project_id,
                "Default ingest key",
                hash_api_key(raw_key),
                raw_key[:16],
                now,
            ),
        )
        self.conn.execute(
            """
            INSERT INTO subscriptions (id, org_id, plan, status, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (subscription_id, org_id, "free", "trialing", now),
        )
        self.audit(org_id, user_id, "org.bootstrap", {"project_id": project_id})
        self.conn.commit()
        return {
            "org_id": org_id,
            "user_id": user_id,
            "project_id": project_id,
            "api_key": raw_key,
            "db_path": self.db_path,
        }

    def audit(self, org_id: str | None, actor_user_id: str | None, action: str, metadata: dict):
        self.conn.execute(
            """
            INSERT INTO audit_logs (id, org_id, actor_user_id, action, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (str(uuid.uuid4()), org_id, actor_user_id, action, json.dumps(metadata), utc_now()),
        )

    def authenticate(self, raw_key: str) -> sqlite3.Row | None:
        key_hash = hash_api_key(raw_key)
        row = self.conn.execute(
            """
            SELECT api_keys.*, orgs.name AS org_name, projects.name AS project_name
            FROM api_keys
            JOIN orgs ON orgs.id = api_keys.org_id
            JOIN projects ON projects.id = api_keys.project_id
            WHERE api_keys.key_hash = ? AND api_keys.revoked_at IS NULL
            """,
            (key_hash,),
        ).fetchone()
        if row:
            self.conn.execute(
                "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
                (utc_now(), row["id"]),
            )
            self.conn.commit()
        return row

    def ingest(self, auth: sqlite3.Row, events: list[dict]) -> dict:
        pricer = Pricer()
        inserted = 0
        duplicates = 0
        errors: list[dict] = []
        now = utc_now()

        for idx, event in enumerate(events):
            try:
                call = normalize_event(event, pricer)
                external_id = str(event.get("external_id", event.get("externalId", call.id)) or call.id)
                self.conn.execute(
                    """
                    INSERT INTO llm_calls
                        (id, org_id, project_id, external_id, timestamp, provider, model,
                         input_tokens, output_tokens, cached_tokens, input_cost, output_cost,
                         total_cost, agent_name, workflow, customer, latency_ms, success,
                         error, tags, inserted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        call.id,
                        auth["org_id"],
                        auth["project_id"],
                        external_id,
                        call.timestamp,
                        call.provider,
                        call.model,
                        call.input_tokens,
                        call.output_tokens,
                        call.cached_tokens,
                        call.input_cost,
                        call.output_cost,
                        call.total_cost,
                        call.agent_name,
                        call.workflow,
                        call.customer,
                        call.latency_ms,
                        int(call.success),
                        call.error,
                        json.dumps(call.tags),
                        now,
                    ),
                )
                inserted += 1
            except sqlite3.IntegrityError:
                duplicates += 1
            except Exception as exc:
                errors.append({"index": idx, "error": str(exc)})

        self.conn.commit()
        return {"inserted": inserted, "duplicates": duplicates, "errors": errors}

    def get_calls(
        self,
        org_id: str,
        project_id: str | None = None,
        start_time: float = 0,
        end_time: float = 0,
        limit: int = 10000,
    ) -> list[LLMCall]:
        conditions = ["org_id = ?"]
        params: list = [org_id]
        if project_id:
            conditions.append("project_id = ?")
            params.append(project_id)
        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)
        params.append(limit)
        rows = self.conn.execute(
            f"""
            SELECT * FROM llm_calls
            WHERE {' AND '.join(conditions)}
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
        return [row_to_call(r) for r in rows]

    def report(self, org_id: str, project_id: str | None = None, days: int = 30) -> CostReport:
        end = utc_now()
        start = end - days * 86400 if days else 0
        report = CostReport(period_start=start, period_end=end)
        for call in self.get_calls(org_id, project_id, start, end, limit=100000):
            report.add_call(call)
        return report

    def budgets(self, org_id: str, project_id: str | None = None) -> list[dict]:
        params = [org_id]
        where = "org_id = ?"
        if project_id:
            where += " AND (project_id = ? OR project_id IS NULL)"
            params.append(project_id)
        rows = self.conn.execute(
            f"SELECT * FROM budgets WHERE {where} ORDER BY created_at DESC",
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def budget_status(self, org_id: str, project_id: str | None = None) -> list[dict]:
        statuses = []
        now = utc_now()
        for budget in self.budgets(org_id, project_id):
            start = period_start(budget["period"], now)
            spend = self._budget_spend(org_id, budget, project_id, start, now)
            pct = (spend / budget["limit_usd"]) * 100 if budget["limit_usd"] else 0
            statuses.append({
                **budget,
                "period_start": start,
                "period_end": now,
                "current_spend": round(spend, 6),
                "pct_used": round(pct, 2),
                "remaining_usd": round(max(budget["limit_usd"] - spend, 0), 6),
                "alert_triggered": pct >= budget["alert_at_pct"],
                "exceeded": spend >= budget["limit_usd"],
            })
        return statuses

    def alert_channels(self, org_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM alert_channels WHERE org_id = ? ORDER BY created_at DESC",
            (org_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def create_alert_channel(self, org_id: str, payload: dict) -> dict:
        name = str(payload.get("name") or "Alert channel").strip()
        channel_type = str(payload.get("type") or "log").strip().lower()
        target = str(payload.get("target") or "").strip()
        enabled = bool(payload.get("enabled", True))
        allowed = {"log", "webhook", "slack", "discord", "email", "telegram"}
        if channel_type not in allowed:
            raise ValueError(f"type must be one of: {', '.join(sorted(allowed))}")
        if channel_type in {"webhook", "slack", "discord", "email", "telegram"} and not target:
            raise ValueError("target is required for this alert channel type")

        channel_id = str(uuid.uuid4())
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO alert_channels (id, org_id, name, type, target, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (channel_id, org_id, name, channel_type, target, int(enabled), now),
        )
        self.audit(org_id, None, "alert_channel.create", {"channel_id": channel_id})
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM alert_channels WHERE id = ?", (channel_id,)).fetchone())

    def evaluate_budget_alerts(
        self,
        org_id: str,
        project_id: str | None = None,
        send: bool = True,
    ) -> dict:
        channels = [c for c in self.alert_channels(org_id) if c["enabled"]]
        if not channels:
            channels = [{
                "id": None,
                "org_id": org_id,
                "name": "Activity log",
                "type": "log",
                "target": "",
                "enabled": 1,
            }]

        created = []
        skipped = 0
        for budget in self.budget_status(org_id, project_id):
            if not budget["alert_triggered"] and not budget["exceeded"]:
                continue
            severity = "critical" if budget["exceeded"] else "warning"
            message = (
                f"{budget['name']} is at {budget['pct_used']:.2f}% "
                f"(${budget['current_spend']:.4f} of ${budget['limit_usd']:.2f})"
            )
            for channel in channels:
                if self._alert_event_exists(budget["id"], channel["id"], budget["period_start"], severity):
                    skipped += 1
                    continue
                status, error = self._deliver_alert(channel, message, budget) if send else ("pending", "")
                event = self._record_alert_event(
                    org_id=org_id,
                    budget_id=budget["id"],
                    channel_id=channel["id"],
                    severity=severity,
                    message=message,
                    current_spend=budget["current_spend"],
                    pct_used=budget["pct_used"],
                    period_start=budget["period_start"],
                    status=status,
                    error=error,
                )
                created.append(event)

        self.conn.commit()
        return {"created": len(created), "skipped": skipped, "alerts": created}

    def _alert_event_exists(
        self,
        budget_id: str,
        channel_id: str | None,
        period_start_value: float,
        severity: str,
    ) -> bool:
        if channel_id is None:
            row = self.conn.execute(
                """
                SELECT 1 FROM alert_events
                WHERE budget_id = ? AND channel_id IS NULL AND period_start = ? AND severity = ?
                """,
                (budget_id, period_start_value, severity),
            ).fetchone()
        else:
            row = self.conn.execute(
                """
                SELECT 1 FROM alert_events
                WHERE budget_id = ? AND channel_id = ? AND period_start = ? AND severity = ?
                """,
                (budget_id, channel_id, period_start_value, severity),
            ).fetchone()
        return bool(row)

    def _record_alert_event(
        self,
        *,
        org_id: str,
        budget_id: str,
        channel_id: str | None,
        severity: str,
        message: str,
        current_spend: float,
        pct_used: float,
        period_start: float,
        status: str,
        error: str,
    ) -> dict:
        event_id = str(uuid.uuid4())
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO alert_events
                (id, org_id, budget_id, channel_id, severity, message,
                 current_spend, pct_used, period_start, status, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                org_id,
                budget_id,
                channel_id,
                severity,
                message,
                current_spend,
                pct_used,
                period_start,
                status,
                error,
                now,
            ),
        )
        self.audit(org_id, None, "alert_event.create", {"alert_event_id": event_id})
        return dict(self.conn.execute("SELECT * FROM alert_events WHERE id = ?", (event_id,)).fetchone())

    def _deliver_alert(self, channel: dict, message: str, budget: dict) -> tuple[str, str]:
        channel_type = channel["type"]
        if channel_type == "log":
            return "delivered", ""
        if channel_type in {"email", "telegram"}:
            return "pending", f"{channel_type} delivery adapter is not configured in local scaffold"
        if channel_type in {"webhook", "slack", "discord"}:
            body = json.dumps({
                "text": message,
                "source": "tokimeter",
                "severity": "critical" if budget["exceeded"] else "warning",
                "budget": budget,
            }).encode()
            try:
                req = urllib.request.Request(
                    channel["target"],
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as res:
                    if 200 <= res.status < 300:
                        return "delivered", ""
                    return "failed", f"HTTP {res.status}"
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                return "failed", str(exc)
        return "pending", "unknown channel type"

    def alert_events(self, org_id: str, limit: int = 100) -> list[dict]:
        rows = self.conn.execute(
            """
            SELECT alert_events.*, budgets.name AS budget_name, alert_channels.name AS channel_name,
                   alert_channels.type AS channel_type
            FROM alert_events
            LEFT JOIN budgets ON budgets.id = alert_events.budget_id
            LEFT JOIN alert_channels ON alert_channels.id = alert_events.channel_id
            WHERE alert_events.org_id = ?
            ORDER BY alert_events.created_at DESC
            LIMIT ?
            """,
            (org_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def calls_csv(
        self,
        org_id: str,
        project_id: str | None = None,
        days: int = 30,
        limit: int = 100000,
    ) -> str:
        end = utc_now()
        start = end - days * 86400 if days else 0
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "id", "timestamp", "provider", "model", "input_tokens",
            "output_tokens", "cached_tokens", "input_cost", "output_cost",
            "total_cost", "agent_name", "workflow", "customer", "latency_ms",
            "success", "error",
        ])
        for call in self.get_calls(org_id, project_id, start, end, limit=limit):
            writer.writerow([
                call.id,
                call.timestamp,
                call.provider,
                call.model,
                call.input_tokens,
                call.output_tokens,
                call.cached_tokens,
                f"{call.input_cost:.9f}",
                f"{call.output_cost:.9f}",
                f"{call.total_cost:.9f}",
                call.agent_name,
                call.workflow,
                call.customer,
                call.latency_ms,
                call.success,
                call.error,
            ])
        return output.getvalue()

    def digest(self, org_id: str, project_id: str | None = None, days: int = 7) -> dict:
        report = self.report(org_id, project_id, days)
        calls = self.get_calls(
            org_id,
            project_id,
            start_time=utc_now() - days * 86400,
            limit=100000,
        )
        recs = Optimizer().analyze(calls, period_days=days)
        budgets = self.budget_status(org_id, project_id)
        top_model = top_item(report.by_model)
        top_agent = top_item(report.by_agent)
        return {
            "generated_at": utc_now(),
            "period_days": days,
            "summary": {
                "total_cost": round(report.total_cost, 6),
                "total_calls": report.total_calls,
                "total_input_tokens": report.total_input_tokens,
                "total_output_tokens": report.total_output_tokens,
                "top_model": top_model,
                "top_agent": top_agent,
                "active_budget_alerts": len([b for b in budgets if b["alert_triggered"]]),
                "estimated_monthly_savings": round(sum(r.estimated_savings_monthly for r in recs), 2),
            },
            "report": report_to_dict(report),
            "recommendations": [recommendation_to_dict(r) for r in recs[:10]],
            "budgets": budgets,
        }

    def _budget_spend(
        self,
        org_id: str,
        budget: dict,
        selected_project_id: str | None,
        start_time: float,
        end_time: float,
    ) -> float:
        conditions = ["org_id = ?", "timestamp >= ?", "timestamp <= ?"]
        params: list = [org_id, start_time, end_time]
        project_id = budget.get("project_id") or selected_project_id
        if project_id:
            conditions.append("project_id = ?")
            params.append(project_id)
        for field in ("agent_name", "model", "customer"):
            if budget.get(field):
                conditions.append(f"{field} = ?")
                params.append(budget[field])
        row = self.conn.execute(
            f"SELECT COALESCE(SUM(total_cost), 0) AS spend FROM llm_calls WHERE {' AND '.join(conditions)}",
            params,
        ).fetchone()
        return float(row["spend"] or 0)

    def create_budget(self, org_id: str, payload: dict, default_project_id: str | None = None) -> dict:
        name = str(payload.get("name") or "Budget").strip()
        limit_usd = float(payload.get("limit_usd", payload.get("limitUsd", 0)) or 0)
        period = str(payload.get("period") or "monthly").strip().lower()
        project_id = payload.get("project_id", payload.get("projectId", default_project_id))
        agent_name = str(payload.get("agent_name", payload.get("agentName", "")) or "")
        model = str(payload.get("model", "") or "")
        customer = str(payload.get("customer", "") or "")
        alert_at_pct = float(payload.get("alert_at_pct", payload.get("alertAtPct", 80)) or 80)

        if limit_usd <= 0:
            raise ValueError("limit_usd must be greater than 0")
        if period not in {"daily", "weekly", "monthly"}:
            raise ValueError("period must be daily, weekly, or monthly")
        if project_id and not self._project_belongs_to_org(org_id, project_id):
            raise ValueError("project_id does not belong to this organization")

        budget_id = str(uuid.uuid4())
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO budgets
                (id, org_id, project_id, name, limit_usd, period, agent_name,
                 model, customer, alert_at_pct, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                budget_id,
                org_id,
                project_id,
                name,
                limit_usd,
                period,
                agent_name,
                model,
                customer,
                alert_at_pct,
                now,
            ),
        )
        self.audit(org_id, None, "budget.create", {"budget_id": budget_id})
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM budgets WHERE id = ?", (budget_id,)).fetchone())

    def projects(self, org_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM projects WHERE org_id = ? ORDER BY created_at ASC",
            (org_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def create_project(self, org_id: str, name: str, environment: str = "production") -> dict:
        project_id = str(uuid.uuid4())
        slug = self._unique_project_slug(org_id, name)
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO projects (id, org_id, name, slug, environment, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, org_id, name, slug, environment or "production", now),
        )
        self.audit(org_id, None, "project.create", {"project_id": project_id})
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())

    def _unique_project_slug(self, org_id: str, name: str) -> str:
        base = slugify(name)
        slug = base
        suffix = 2
        while self.conn.execute(
            "SELECT 1 FROM projects WHERE org_id = ? AND slug = ?",
            (org_id, slug),
        ).fetchone():
            slug = f"{base}-{suffix}"
            suffix += 1
        return slug

    def _project_belongs_to_org(self, org_id: str, project_id: str) -> bool:
        return bool(self.conn.execute(
            "SELECT 1 FROM projects WHERE org_id = ? AND id = ?",
            (org_id, project_id),
        ).fetchone())

    def api_keys(self, org_id: str, project_id: str | None = None) -> list[dict]:
        conditions = ["api_keys.org_id = ?"]
        params: list = [org_id]
        if project_id:
            conditions.append("api_keys.project_id = ?")
            params.append(project_id)
        rows = self.conn.execute(
            f"""
            SELECT api_keys.id, api_keys.org_id, api_keys.project_id,
                   projects.name AS project_name, api_keys.name, api_keys.prefix,
                   api_keys.last_used_at, api_keys.revoked_at, api_keys.created_at
            FROM api_keys
            JOIN projects ON projects.id = api_keys.project_id
            WHERE {' AND '.join(conditions)}
            ORDER BY api_keys.created_at DESC
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def create_api_key(self, org_id: str, project_id: str, name: str = "API key") -> dict:
        if not self._project_belongs_to_org(org_id, project_id):
            raise ValueError("project_id does not belong to this organization")

        api_key_id = str(uuid.uuid4())
        raw_key = new_api_key()
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO api_keys (id, org_id, project_id, name, key_hash, prefix, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                api_key_id,
                org_id,
                project_id,
                name or "API key",
                hash_api_key(raw_key),
                raw_key[:16],
                now,
            ),
        )
        self.audit(org_id, None, "api_key.create", {"api_key_id": api_key_id, "project_id": project_id})
        self.conn.commit()
        return {
            "id": api_key_id,
            "org_id": org_id,
            "project_id": project_id,
            "name": name or "API key",
            "prefix": raw_key[:16],
            "api_key": raw_key,
            "created_at": now,
        }

    def revoke_api_key(self, org_id: str, key_id: str) -> bool:
        cur = self.conn.execute(
            """
            UPDATE api_keys
            SET revoked_at = ?
            WHERE org_id = ? AND id = ? AND revoked_at IS NULL
            """,
            (utc_now(), org_id, key_id),
        )
        if cur.rowcount:
            self.audit(org_id, None, "api_key.revoke", {"api_key_id": key_id})
        self.conn.commit()
        return cur.rowcount > 0

    def subscription(self, org_id: str) -> dict:
        row = self.conn.execute(
            "SELECT * FROM subscriptions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
            (org_id,),
        ).fetchone()
        return dict(row) if row else {}

    def set_subscription(self, org_id: str, plan: str, status: str = "active") -> dict:
        allowed_plans = {"free", "pro", "team", "enterprise"}
        if plan not in allowed_plans:
            raise ValueError(f"plan must be one of: {', '.join(sorted(allowed_plans))}")
        row = self.conn.execute(
            "SELECT id FROM subscriptions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
            (org_id,),
        ).fetchone()
        now = utc_now()
        if row:
            self.conn.execute(
                "UPDATE subscriptions SET plan = ?, status = ?, current_period_end = ? WHERE id = ?",
                (plan, status or "active", now + 30 * 86400, row["id"]),
            )
        else:
            self.conn.execute(
                """
                INSERT INTO subscriptions (id, org_id, plan, status, current_period_end, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (str(uuid.uuid4()), org_id, plan, status or "active", now + 30 * 86400, now),
            )
        self.audit(org_id, None, "subscription.update", {"plan": plan, "status": status})
        self.conn.commit()
        return self.subscription(org_id)

    def recent_calls(self, org_id: str, project_id: str | None = None, limit: int = 50) -> list[dict]:
        return [call_to_dict(call) for call in self.get_calls(org_id, project_id, limit=limit)]

    def org_context(self, auth: sqlite3.Row) -> dict:
        return {
            "org": {
                "id": auth["org_id"],
                "name": auth["org_name"],
            },
            "current_project": {
                "id": auth["project_id"],
                "name": auth["project_name"],
            },
            "current_api_key": {
                "id": auth["id"],
                "name": auth["name"],
                "prefix": auth["prefix"],
                "last_used_at": auth["last_used_at"],
            },
            "projects": self.projects(auth["org_id"]),
            "subscription": self.subscription(auth["org_id"]),
        }

    def close(self):
        self.conn.close()


def row_to_call(row: sqlite3.Row) -> LLMCall:
    tags = row["tags"] or "{}"
    try:
        parsed_tags = json.loads(tags)
    except json.JSONDecodeError:
        parsed_tags = {"raw_tags": tags}
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
        tags=parsed_tags,
    )


def report_to_dict(report: CostReport) -> dict:
    return {
        "period_start": report.period_start,
        "period_end": report.period_end,
        "total_cost": round(report.total_cost, 6),
        "total_input_cost": round(report.total_input_cost, 6),
        "total_output_cost": round(report.total_output_cost, 6),
        "total_calls": report.total_calls,
        "total_input_tokens": report.total_input_tokens,
        "total_output_tokens": report.total_output_tokens,
        "by_provider": report.by_provider,
        "by_model": report.by_model,
        "by_agent": report.by_agent,
        "by_workflow": report.by_workflow,
        "by_customer": report.by_customer,
        "by_day": report.by_day,
    }


def call_to_dict(call: LLMCall) -> dict:
    return {
        "id": call.id,
        "timestamp": call.timestamp,
        "provider": call.provider,
        "model": call.model,
        "input_tokens": call.input_tokens,
        "output_tokens": call.output_tokens,
        "cached_tokens": call.cached_tokens,
        "input_cost": round(call.input_cost, 9),
        "output_cost": round(call.output_cost, 9),
        "total_cost": round(call.total_cost, 9),
        "agent_name": call.agent_name,
        "workflow": call.workflow,
        "customer": call.customer,
        "latency_ms": call.latency_ms,
        "success": call.success,
        "error": call.error,
        "tags": call.tags,
    }


def recommendation_to_dict(rec) -> dict:
    data = asdict(rec)
    data["estimated_savings_monthly"] = round(rec.estimated_savings_monthly, 2)
    return data


def period_start(period: str, now: float | None = None) -> float:
    now = now or utc_now()
    current = time.gmtime(now)
    if period == "daily":
        return calendar.timegm((current.tm_year, current.tm_mon, current.tm_mday, 0, 0, 0, 0, 0, 0))
    if period == "weekly":
        day_start = calendar.timegm((current.tm_year, current.tm_mon, current.tm_mday, 0, 0, 0, 0, 0, 0))
        return day_start - current.tm_wday * 86400
    return calendar.timegm((current.tm_year, current.tm_mon, 1, 0, 0, 0, 0, 0, 0))


def top_item(values: dict) -> dict | None:
    if not values:
        return None
    name, value = max(values.items(), key=lambda item: item[1])
    return {"name": name, "value": round(value, 6)}


def slugify(value: str) -> str:
    chars = []
    for ch in value.lower().strip():
        if ch.isalnum():
            chars.append(ch)
        elif chars and chars[-1] != "-":
            chars.append("-")
    slug = "".join(chars).strip("-")
    return slug or "default"


def hosted_dashboard_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tokimeter Hosted</title>
<style>
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --panel: #ffffff;
  --ink: #17202a;
  --muted: #657282;
  --line: #d9dee6;
  --blue: #2563eb;
  --green: #11845b;
  --amber: #a15c00;
  --red: #b42318;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 2;
}
h1, h2 { margin: 0; letter-spacing: 0; }
h1 { font-size: 18px; }
h2 { font-size: 14px; }
main { width: min(1240px, calc(100% - 32px)); margin: 18px auto 32px; }
.toolbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 150px 110px 110px;
  gap: 10px;
  align-items: center;
}
input, select, button {
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  padding: 0 10px;
  font: inherit;
}
button { cursor: pointer; font-weight: 650; }
button.primary { background: var(--blue); border-color: var(--blue); color: white; }
button.ghost { background: #eef2f7; }
.grid { display: grid; gap: 12px; }
.kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px; }
.layout { grid-template-columns: 1.4fr 0.9fr; align-items: start; }
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  min-width: 0;
}
.kpi .label { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.kpi .value { font-size: 24px; font-weight: 750; }
.kpi .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.muted { color: var(--muted); }
.row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
}
.row:first-child { border-top: 0; }
.bars { display: grid; gap: 8px; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 1fr) 2fr 78px; gap: 10px; align-items: center; }
.bar-track { height: 8px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--blue); }
.badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  background: #eef2f7;
  color: var(--muted);
  font-size: 12px;
}
.badge.green { background: #e8f5ef; color: var(--green); }
.badge.amber { background: #fff3df; color: var(--amber); }
.badge.red { background: #fee9e7; color: var(--red); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 6px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 12px; font-weight: 650; }
.budget-form {
  display: grid;
  grid-template-columns: 1fr 120px 110px 120px;
  gap: 8px;
  margin-top: 10px;
}
.empty {
  color: var(--muted);
  padding: 24px 0;
  text-align: center;
}
.error { color: var(--red); font-weight: 650; }
.ok { color: var(--green); font-weight: 650; }
@media (max-width: 860px) {
  header { align-items: stretch; flex-direction: column; }
  .toolbar, .budget-form, .layout, .kpis { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>Tokimeter Hosted</h1>
    <div class="muted" id="tenant">Not connected</div>
  </div>
  <div class="toolbar">
    <input id="apiKey" type="password" autocomplete="off" placeholder="Hosted API key">
    <select id="project"></select>
    <button class="ghost" id="saveKey">Save</button>
    <button class="primary" id="refresh">Refresh</button>
  </div>
</header>
<main>
  <div id="state" class="panel empty">Enter an API key from tokimeter hosted init.</div>
  <section id="app" hidden>
    <div class="grid kpis">
      <div class="panel kpi"><div class="label">Spend</div><div class="value" id="totalCost">$0.00</div><div class="sub" id="callCount">0 calls</div></div>
      <div class="panel kpi"><div class="label">Input tokens</div><div class="value" id="inputTokens">0</div><div class="sub" id="inputCost">$0.00 input</div></div>
      <div class="panel kpi"><div class="label">Output tokens</div><div class="value" id="outputTokens">0</div><div class="sub" id="outputCost">$0.00 output</div></div>
      <div class="panel kpi"><div class="label">Plan</div><div class="value" id="plan">free</div><div class="sub" id="planStatus">trialing</div></div>
    </div>

    <div class="grid layout">
      <div class="grid">
        <div class="panel">
          <div class="section-head"><h2>Spend By Model</h2><span class="muted">Last 30 days</span></div>
          <div id="modelBars" class="bars"></div>
        </div>
        <div class="panel">
          <div class="section-head"><h2>Recent Calls</h2><span class="muted" id="callsMeta"></span></div>
          <div style="overflow:auto"><table id="callsTable"></table></div>
        </div>
      </div>
      <div class="grid">
        <div class="panel">
          <div class="section-head"><h2>Budget Status</h2><span class="muted" id="budgetMeta"></span></div>
          <div id="budgets"></div>
          <form class="budget-form" id="budgetForm">
            <input name="name" placeholder="Budget name" required>
            <input name="limit_usd" type="number" min="0.01" step="0.01" placeholder="USD" required>
            <select name="period"><option>daily</option><option>weekly</option><option selected>monthly</option></select>
            <button class="primary" type="submit">Add</button>
          </form>
        </div>
        <div class="panel">
          <div class="section-head"><h2>Recommendations</h2><span class="muted" id="recMeta"></span></div>
          <div id="recommendations"></div>
        </div>
        <div class="panel">
          <div class="section-head"><h2>API Keys</h2><button class="ghost" id="newKey">New Key</button></div>
          <div id="apiKeys"></div>
          <div class="muted" id="createdKey"></div>
        </div>
        <div class="panel">
          <div class="section-head"><h2>Alerts & Digest</h2><button class="ghost" id="evaluateAlerts">Evaluate</button></div>
          <div id="digest"></div>
          <div id="alerts"></div>
          <form class="budget-form" id="alertForm">
            <input name="name" placeholder="Channel name" required>
            <select name="type"><option selected>log</option><option>webhook</option><option>slack</option><option>discord</option><option>email</option><option>telegram</option></select>
            <input name="target" placeholder="Target URL/email/chat">
            <button class="primary" type="submit">Add</button>
          </form>
          <div style="margin-top:10px"><a id="exportCsv" href="#">Export calls CSV</a></div>
        </div>
      </div>
    </div>
  </section>
</main>
<script>
const apiKeyInput = document.getElementById('apiKey');
const projectSelect = document.getElementById('project');
const state = document.getElementById('state');
const app = document.getElementById('app');
apiKeyInput.value = localStorage.getItem('tokimeter.hosted.key') || '';
let current = { projects: [], subscription: {} };

document.getElementById('saveKey').onclick = () => {
  localStorage.setItem('tokimeter.hosted.key', apiKeyInput.value.trim());
  loadAll();
};
document.getElementById('refresh').onclick = () => loadAll();
projectSelect.onchange = () => loadData();
document.getElementById('budgetForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  await api('/v1/budgets', {
    method: 'POST',
    body: JSON.stringify({
      name: form.get('name'),
      limit_usd: Number(form.get('limit_usd')),
      period: form.get('period'),
      project_id: selectedProject()
    })
  });
  e.currentTarget.reset();
  await loadData();
};
document.getElementById('newKey').onclick = async () => {
  const result = await api('/v1/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Dashboard key', project_id: selectedProject() })
  });
  document.getElementById('createdKey').textContent = result.api_key ? 'Created: ' + result.api_key.api_key : '';
  await loadData();
};
document.getElementById('evaluateAlerts').onclick = async () => {
  await api('/v1/alerts/evaluate', { method: 'POST', body: JSON.stringify({ send: true }) });
  await loadData();
};
document.getElementById('alertForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  await api('/v1/alert-channels', {
    method: 'POST',
    body: JSON.stringify({
      name: form.get('name'),
      type: form.get('type'),
      target: form.get('target')
    })
  });
  e.currentTarget.reset();
  await loadData();
};
document.getElementById('exportCsv').onclick = async (e) => {
  e.preventDefault();
  const qp = '?project_id=' + encodeURIComponent(selectedProject()) + '&days=30';
  const key = apiKeyInput.value.trim();
  const res = await fetch('/v1/export/calls.csv' + qp, {
    headers: { 'Authorization': 'Bearer ' + key }
  });
  if (!res.ok) throw new Error('Export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tokimeter-calls.csv';
  a.click();
  URL.revokeObjectURL(url);
};

function selectedProject() {
  return projectSelect.value || (current.current_project && current.current_project.id) || '';
}

async function api(path, options = {}) {
  const key = apiKeyInput.value.trim();
  if (!key) throw new Error('Missing API key');
  const headers = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
  const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadAll() {
  try {
    state.hidden = false;
    state.textContent = 'Loading...';
    current = await api('/v1/me');
    renderTenant();
    renderProjects();
    state.hidden = true;
    app.hidden = false;
    await loadData();
  } catch (err) {
    app.hidden = true;
    state.hidden = false;
    state.innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>';
  }
}

async function loadData() {
  const qp = '?project_id=' + encodeURIComponent(selectedProject());
  document.getElementById('exportCsv').href = '#';
  const [report, calls, recs, budgets, keys, alerts, digest] = await Promise.all([
    api('/v1/reports' + qp + '&days=30'),
    api('/v1/calls' + qp + '&limit=25'),
    api('/v1/recommendations' + qp + '&days=30'),
    api('/v1/budget-status' + qp),
    api('/v1/api-keys' + qp),
    api('/v1/alerts?limit=10'),
    api('/v1/digest' + qp + '&days=7'),
  ]);
  renderReport(report);
  renderCalls(calls.calls || []);
  renderRecommendations(recs.recommendations || []);
  renderBudgets(budgets.budgets || []);
  renderKeys(keys.api_keys || []);
  renderAlerts(alerts.alerts || []);
  renderDigest(digest);
}

function renderTenant() {
  const sub = current.subscription || {};
  document.getElementById('tenant').textContent = current.org.name + ' / ' + current.current_project.name;
  document.getElementById('plan').textContent = sub.plan || 'free';
  document.getElementById('planStatus').textContent = sub.status || 'trialing';
}

function renderProjects() {
  projectSelect.innerHTML = '';
  for (const project of current.projects || []) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    projectSelect.appendChild(option);
  }
  if (current.current_project) projectSelect.value = current.current_project.id;
}

function renderReport(report) {
  document.getElementById('totalCost').textContent = dollars(report.total_cost);
  document.getElementById('callCount').textContent = (report.total_calls || 0).toLocaleString() + ' calls';
  document.getElementById('inputTokens').textContent = (report.total_input_tokens || 0).toLocaleString();
  document.getElementById('inputCost').textContent = dollars(report.total_input_cost) + ' input';
  document.getElementById('outputTokens').textContent = (report.total_output_tokens || 0).toLocaleString();
  document.getElementById('outputCost').textContent = dollars(report.total_output_cost) + ' output';
  renderBars('modelBars', report.by_model || {});
}

function renderBars(id, values) {
  const el = document.getElementById(id);
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (!rows.length) { el.innerHTML = '<div class="empty">No spend yet</div>'; return; }
  const max = rows[0][1] || 1;
  el.innerHTML = rows.map(([name, cost]) => '<div class="bar-row"><div>' + escapeHtml(name) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, cost / max * 100) + '%"></div></div><div>' + dollars(cost) + '</div></div>').join('');
}

function renderCalls(calls) {
  document.getElementById('callsMeta').textContent = calls.length + ' shown';
  const table = document.getElementById('callsTable');
  if (!calls.length) { table.innerHTML = '<tr><td class="empty">No calls yet</td></tr>'; return; }
  table.innerHTML = '<tr><th>Time</th><th>Agent</th><th>Model</th><th>Tokens</th><th>Cost</th></tr>' +
    calls.map(c => '<tr><td>' + new Date(c.timestamp * 1000).toLocaleString() + '</td><td>' + escapeHtml(c.agent_name) + '</td><td>' + escapeHtml(c.model) + '</td><td>' + (c.input_tokens || 0) + ' -> ' + (c.output_tokens || 0) + '</td><td>' + dollars(c.total_cost) + '</td></tr>').join('');
}

function renderRecommendations(recs) {
  document.getElementById('recMeta').textContent = recs.length + ' active';
  const el = document.getElementById('recommendations');
  if (!recs.length) { el.innerHTML = '<div class="empty">No recommendations yet</div>'; return; }
  el.innerHTML = recs.map(r => '<div class="row"><div><strong>' + escapeHtml(r.title) + '</strong><div class="muted">' + escapeHtml(r.action || r.description || '') + '</div></div><span class="badge green">Save ' + dollars(r.estimated_savings_monthly || 0) + '/mo</span></div>').join('');
}

function renderBudgets(budgets) {
  document.getElementById('budgetMeta').textContent = budgets.length + ' configured';
  const el = document.getElementById('budgets');
  if (!budgets.length) { el.innerHTML = '<div class="empty">No budgets yet</div>'; return; }
  el.innerHTML = budgets.map(b => {
    const cls = b.exceeded ? 'red' : (b.alert_triggered ? 'amber' : 'green');
    return '<div class="row"><div><strong>' + escapeHtml(b.name) + '</strong><div class="muted">' + b.period + ' / ' + dollars(b.current_spend) + ' of ' + dollars(b.limit_usd) + '</div></div><span class="badge ' + cls + '">' + b.pct_used + '%</span></div>';
  }).join('');
}

function renderKeys(keys) {
  const el = document.getElementById('apiKeys');
  if (!keys.length) { el.innerHTML = '<div class="empty">No API keys</div>'; return; }
  el.innerHTML = keys.map(k => '<div class="row"><div><strong>' + escapeHtml(k.name) + '</strong><div class="muted">' + escapeHtml(k.prefix) + ' / ' + escapeHtml(k.project_name) + '</div></div><span class="badge ' + (k.revoked_at ? 'red' : 'green') + '">' + (k.revoked_at ? 'revoked' : 'active') + '</span></div>').join('');
}

function renderAlerts(alerts) {
  const el = document.getElementById('alerts');
  if (!alerts.length) { el.innerHTML = '<div class="empty">No alert events yet</div>'; return; }
  el.innerHTML = alerts.map(a => '<div class="row"><div><strong>' + escapeHtml(a.severity) + '</strong><div class="muted">' + escapeHtml(a.message) + '</div></div><span class="badge ' + (a.status === 'delivered' ? 'green' : 'amber') + '">' + escapeHtml(a.status) + '</span></div>').join('');
}

function renderDigest(digest) {
  const el = document.getElementById('digest');
  const summary = digest.summary || {};
  el.innerHTML = '<div class="row"><div><strong>7-day digest</strong><div class="muted">'
    + (summary.total_calls || 0) + ' calls / ' + dollars(summary.total_cost || 0)
    + ' / save ' + dollars(summary.estimated_monthly_savings || 0) + '/mo</div></div>'
    + '<span class="badge ' + ((summary.active_budget_alerts || 0) ? 'amber' : 'green') + '">'
    + (summary.active_budget_alerts || 0) + ' alerts</span></div>';
}

function dollars(value) { return '$' + Number(value || 0).toFixed(4); }
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

if (apiKeyInput.value) loadAll();
</script>
</body>
</html>"""


class HostedAPIHandler(BaseHTTPRequestHandler):
    store: HostedStore = None

    def log_message(self, format, *args):
        return

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path in ("/", "/dashboard"):
            html_response(self, 200, hosted_dashboard_html())
            return

        if parsed.path == "/health":
            json_response(self, 200, {"status": "ok", "service": "tokimeter-hosted"})
            return

        auth = self._require_auth()
        if not auth:
            return

        project_id = self._project_id(query, auth)
        if parsed.path == "/v1/me":
            json_response(self, 200, self.store.org_context(auth))
            return

        if parsed.path == "/v1/projects":
            json_response(self, 200, {"projects": self.store.projects(auth["org_id"])})
            return

        if parsed.path == "/v1/api-keys":
            json_response(self, 200, {"api_keys": self.store.api_keys(auth["org_id"], project_id)})
            return

        if parsed.path == "/v1/calls":
            limit = int(query.get("limit", ["50"])[0])
            json_response(self, 200, {"calls": self.store.recent_calls(auth["org_id"], project_id, limit)})
            return

        if parsed.path == "/v1/reports":
            days = int(query.get("days", ["30"])[0])
            report = self.store.report(auth["org_id"], project_id=project_id, days=days)
            json_response(self, 200, report_to_dict(report))
            return

        if parsed.path == "/v1/recommendations":
            days = int(query.get("days", ["30"])[0])
            start = utc_now() - days * 86400
            calls = self.store.get_calls(auth["org_id"], project_id, start_time=start, limit=100000)
            recs = Optimizer().analyze(calls, period_days=days)
            json_response(self, 200, {"recommendations": [recommendation_to_dict(r) for r in recs]})
            return

        if parsed.path == "/v1/budgets":
            json_response(self, 200, {"budgets": self.store.budgets(auth["org_id"], project_id)})
            return

        if parsed.path == "/v1/budget-status":
            json_response(self, 200, {"budgets": self.store.budget_status(auth["org_id"], project_id)})
            return

        if parsed.path == "/v1/alert-channels":
            json_response(self, 200, {"alert_channels": self.store.alert_channels(auth["org_id"])})
            return

        if parsed.path == "/v1/alerts":
            limit = int(query.get("limit", ["100"])[0])
            json_response(self, 200, {"alerts": self.store.alert_events(auth["org_id"], limit)})
            return

        if parsed.path == "/v1/digest":
            days = int(query.get("days", ["7"])[0])
            json_response(self, 200, self.store.digest(auth["org_id"], project_id, days))
            return

        if parsed.path == "/v1/export/calls.csv":
            days = int(query.get("days", ["30"])[0])
            csv_text = self.store.calls_csv(auth["org_id"], project_id, days=days)
            csv_response(self, "tokimeter-calls.csv", csv_text)
            return

        error_response(self, 404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)

        auth = self._require_auth()
        if not auth:
            return

        try:
            payload = self._read_json()
        except ValueError as exc:
            error_response(self, 400, str(exc))
            return

        if parsed.path == "/v1/events":
            events = [payload]
            result = self.store.ingest(auth, events)
            status = 202 if not result["errors"] else 207
            json_response(self, status, result)
            return

        if parsed.path == "/v1/events/batch":
            events = payload.get("events", []) if isinstance(payload, dict) else payload
            if not isinstance(events, list):
                error_response(self, 400, "Batch payload must be a list or {events: [...]}")
                return
            result = self.store.ingest(auth, events)
            status = 202 if not result["errors"] else 207
            json_response(self, status, result)
            return

        if parsed.path == "/v1/projects":
            name = str(payload.get("name") or "").strip()
            if not name:
                error_response(self, 400, "Project name is required")
                return
            project = self.store.create_project(
                auth["org_id"],
                name,
                str(payload.get("environment") or "production"),
            )
            json_response(self, 201, {"project": project})
            return

        if parsed.path == "/v1/api-keys":
            project_id = str(payload.get("project_id", payload.get("projectId", auth["project_id"])))
            name = str(payload.get("name") or "API key")
            try:
                key = self.store.create_api_key(auth["org_id"], project_id, name)
            except ValueError as exc:
                error_response(self, 400, str(exc))
                return
            json_response(self, 201, {"api_key": key})
            return

        if parsed.path == "/v1/api-keys/revoke":
            key_id = str(payload.get("id", payload.get("key_id", payload.get("keyId", ""))) or "")
            if not key_id:
                error_response(self, 400, "API key id is required")
                return
            revoked = self.store.revoke_api_key(auth["org_id"], key_id)
            json_response(self, 200 if revoked else 404, {"revoked": revoked})
            return

        if parsed.path == "/v1/budgets":
            try:
                budget = self.store.create_budget(auth["org_id"], payload, auth["project_id"])
            except ValueError as exc:
                error_response(self, 400, str(exc))
                return
            json_response(self, 201, {"budget": budget})
            return

        if parsed.path == "/v1/subscription":
            try:
                subscription = self.store.set_subscription(
                    auth["org_id"],
                    str(payload.get("plan") or "pro"),
                    str(payload.get("status") or "active"),
                )
            except ValueError as exc:
                error_response(self, 400, str(exc))
                return
            json_response(self, 200, {"subscription": subscription})
            return

        if parsed.path == "/v1/alert-channels":
            try:
                channel = self.store.create_alert_channel(auth["org_id"], payload)
            except ValueError as exc:
                error_response(self, 400, str(exc))
                return
            json_response(self, 201, {"alert_channel": channel})
            return

        if parsed.path == "/v1/alerts/evaluate":
            send = bool(payload.get("send", True))
            result = self.store.evaluate_budget_alerts(auth["org_id"], auth["project_id"], send=send)
            json_response(self, 200, result)
            return

        error_response(self, 404, "Not found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        auth = self._require_auth()
        if not auth:
            return

        if parsed.path.startswith("/v1/api-keys/"):
            key_id = parsed.path.rsplit("/", 1)[-1]
            revoked = self.store.revoke_api_key(auth["org_id"], key_id)
            json_response(self, 200 if revoked else 404, {"revoked": revoked})
            return

        error_response(self, 404, "Not found")

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            raise ValueError("Missing JSON body")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode())
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON: {exc}") from exc

    def _require_auth(self) -> sqlite3.Row | None:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            error_response(self, 401, "Missing bearer token")
            return None
        raw_key = header.replace("Bearer ", "", 1).strip()
        auth = self.store.authenticate(raw_key)
        if not auth:
            error_response(self, 403, "Invalid API key")
            return None
        return auth

    def _project_id(self, query: dict, auth: sqlite3.Row) -> str | None:
        raw = query.get("project_id", query.get("projectId", [auth["project_id"]]))[0]
        if raw in ("", "all", "*"):
            return None
        return raw


def launch_hosted_api(db_path: str = DEFAULT_DB_PATH, host: str = "127.0.0.1", port: int = 8789):
    store = HostedStore(db_path)
    handler = type("Handler", (HostedAPIHandler,), {"store": store})
    server = HTTPServer((host, port), handler)
    print(f"Tokimeter hosted API running at http://{host}:{port}")
    print("Dashboard: /")
    print("Endpoints: /health, /v1/me, /v1/events, /v1/reports, /v1/recommendations, /v1/budget-status")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nHosted API stopped.")
    finally:
        server.server_close()
        store.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tokimeter-hosted")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Initialize hosted DB and create first org/project/API key")
    init.add_argument("--org", required=True)
    init.add_argument("--email", required=True)
    init.add_argument("--project", default="default")

    serve = sub.add_parser("serve", help="Run hosted API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8789)

    args = parser.parse_args(argv)
    if args.command == "init":
        store = HostedStore(args.db)
        try:
            result = store.bootstrap(args.org, args.email, args.project)
        finally:
            store.close()
        print(json.dumps(result, indent=2))
        return 0

    if args.command == "serve":
        launch_hosted_api(args.db, args.host, args.port)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
