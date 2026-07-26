"""
Budget alerts for Tokimeter.

Sends notifications when spending crosses defined thresholds.

Supports:
  - Slack incoming webhooks
  - Email (via any SMTP server)
  - Generic HTTP webhooks (Discord, MS Teams, Zapier, n8n, etc.)

Usage:
    from tokimeter import Tracker
    from tokimeter.alerts import BudgetMonitor, Budget, SlackNotifier

    tracker = Tracker("finops.db")

    # Define budgets
    budgets = [
        Budget(name="Daily Cap", limit=10.0, period="daily",
               agent_name="support-bot"),
        Budget(name="Monthly Total", limit=500.0, period="monthly"),
    ]

    # Set up alerts
    monitor = BudgetMonitor(
        tracker=tracker,
        budgets=budgets,
        notifiers=[
            SlackNotifier(webhook_url="https://hooks.slack.com/services/..."),
            WebhookNotifier(url="https://your-app.com/webhook"),
        ],
    )

    # Check budgets (call periodically, e.g. every 5 minutes)
    monitor.check()

    # Or run as a background thread
    monitor.start(interval_seconds=300)  # check every 5 min
    monitor.stop()
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
import threading
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Optional

from .core import Tracker

logger = logging.getLogger("tokimeter")


# ─── Budgets ─────────────────────────────────────────────────────────────────


@dataclass
class Budget:
    """
    A spending budget.

    Args:
        name: Human-readable budget name.
        limit: Maximum spend in USD.
        period: "daily", "weekly", "monthly", or "total".
        agent_name: Optional — restrict budget to a specific agent.
        model: Optional — restrict budget to a specific model.
        customer: Optional — restrict budget to a specific customer.
        alert_at_pct: Alert when spend reaches this percentage of the limit.
                      Default: 80 (alert at 80%).
    """
    name: str
    limit: float
    period: str = "monthly"  # daily, weekly, monthly, total
    agent_name: str = ""
    model: str = ""
    customer: str = ""
    alert_at_pct: float = 80.0

    # Internal tracking — which budgets have already been alerted
    _last_alerted_pct: float = field(default=0.0, repr=False)


# ─── Notifiers ───────────────────────────────────────────────────────────────


class SlackNotifier:
    """Send alerts to a Slack channel via incoming webhook."""

    def __init__(self, webhook_url: str = "", channel: str = ""):
        self.webhook_url = webhook_url or os.environ.get("TOKIMETER_SLACK_WEBHOOK", "")
        self.channel = channel

    def send(self, budget: Budget, current_spend: float, pct: float):
        if not self.webhook_url:
            logger.warning("SlackNotifier: no webhook URL configured")
            return

        emoji = "🚨" if pct >= 100 else "⚠️"
        scope = []
        if budget.agent_name:
            scope.append(f"agent: {budget.agent_name}")
        if budget.model:
            scope.append(f"model: {budget.model}")
        if budget.customer:
            scope.append(f"customer: {budget.customer}")
        scope_str = f" ({', '.join(scope)})" if scope else ""

        text = (
            f"{emoji} *Tokimeter Budget Alert*\n"
            f"Budget: *{budget.name}*{scope_str}\n"
            f"Spend: *${current_spend:.2f}* / ${budget.limit:.2f} ({pct:.0f}%)\n"
            f"Period: {budget.period}\n"
        )

        payload = {"text": text}
        if self.channel:
            payload["channel"] = self.channel

        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                self.webhook_url, data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            logger.error("Slack alert failed: %s", e)


class EmailNotifier:
    """Send alerts via email using SMTP."""

    def __init__(
        self,
        smtp_host: str = "",
        smtp_port: int = 587,
        username: str = "",
        password: str = "",
        from_addr: str = "",
        to_addrs: list[str] | None = None,
        use_tls: bool = True,
    ):
        self.smtp_host = smtp_host or os.environ.get("TOKIMETER_SMTP_HOST", "")
        self.smtp_port = smtp_port
        self.username = username or os.environ.get("TOKIMETER_SMTP_USER", "")
        self.password = password or os.environ.get("TOKIMETER_SMTP_PASSWORD", "")
        self.from_addr = from_addr or self.username
        self.to_addrs = to_addrs or []
        self.use_tls = use_tls

    def send(self, budget: Budget, current_spend: float, pct: float):
        if not self.smtp_host or not self.to_addrs:
            logger.warning("EmailNotifier: not configured")
            return

        status = "EXCEEDED" if pct >= 100 else "WARNING"

        msg = EmailMessage()
        msg["Subject"] = f"[Tokimeter] {status}: {budget.name} at {pct:.0f}%"
        msg["From"] = self.from_addr
        msg["To"] = ", ".join(self.to_addrs)

        body = (
            f"Budget Alert: {budget.name}\n\n"
            f"Current spend: ${current_spend:.2f}\n"
            f"Budget limit: ${budget.limit:.2f}\n"
            f"Usage: {pct:.0f}%\n"
            f"Period: {budget.period}\n"
        )
        if budget.agent_name:
            body += f"Agent: {budget.agent_name}\n"
        if budget.model:
            body += f"Model: {budget.model}\n"
        if budget.customer:
            body += f"Customer: {budget.customer}\n"

        msg.set_content(body)

        try:
            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                if self.use_tls:
                    server.starttls()
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.send_message(msg)
        except Exception as e:
            logger.error("Email alert failed: %s", e)


class WebhookNotifier:
    """Send alerts to a generic HTTP webhook (Discord, Teams, Zapier, etc.)."""

    def __init__(self, url: str = "", headers: dict | None = None):
        self.url = url or os.environ.get("TOKIMETER_WEBHOOK_URL", "")
        self.headers = headers or {"Content-Type": "application/json"}

    def send(self, budget: Budget, current_spend: float, pct: float):
        if not self.url:
            logger.warning("WebhookNotifier: no URL configured")
            return

        payload = {
            "source": "tokimeter",
            "type": "budget_alert",
            "budget_name": budget.name,
            "current_spend": round(current_spend, 4),
            "limit": budget.limit,
            "percentage": round(pct, 1),
            "period": budget.period,
            "exceeded": pct >= 100,
            "agent_name": budget.agent_name,
            "model": budget.model,
            "customer": budget.customer,
            "timestamp": time.time(),
        }

        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                self.url, data=data, headers=self.headers, method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            logger.error("Webhook alert failed: %s", e)


class DiscordNotifier:
    """Send alerts to a Discord channel via webhook."""

    def __init__(self, webhook_url: str = ""):
        self.webhook_url = webhook_url or os.environ.get("TOKIMETER_DISCORD_WEBHOOK", "")

    def send(self, budget: Budget, current_spend: float, pct: float):
        if not self.webhook_url:
            logger.warning("DiscordNotifier: no webhook URL configured")
            return

        color = 0xf85149 if pct >= 100 else 0xd29922  # red / yellow
        scope = []
        if budget.agent_name:
            scope.append(f"Agent: {budget.agent_name}")
        if budget.model:
            scope.append(f"Model: {budget.model}")
        if budget.customer:
            scope.append(f"Customer: {budget.customer}")

        payload = {
            "embeds": [{
                "title": "💰 Tokimeter Budget Alert",
                "description": (
                    f"**{budget.name}** has reached **{pct:.0f}%** of its budget\n"
                    f"Spend: **${current_spend:.2f}** / ${budget.limit:.2f}\n"
                    f"Period: {budget.period}"
                ),
                "color": color,
                "fields": [{"name": s.split(": ")[0], "value": s.split(": ")[1], "inline": True}
                           for s in scope if ": " in s],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }]
        }

        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                self.webhook_url, data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            logger.error("Discord alert failed: %s", e)


# ─── Budget Monitor ──────────────────────────────────────────────────────────


class BudgetMonitor:
    """
    Monitors spending against defined budgets and triggers alerts.

    Usage:
        monitor = BudgetMonitor(tracker, budgets, notifiers)
        monitor.check()           # manual check
        monitor.start(300)        # auto-check every 5 minutes
        monitor.stop()            # stop auto-checking
    """

    def __init__(
        self,
        tracker: Tracker,
        budgets: list[Budget],
        notifiers: list = None,
    ):
        self.tracker = tracker
        self.budgets = budgets
        self.notifiers = notifiers or []
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def check(self):
        """Check all budgets and fire alerts if thresholds are crossed."""
        now = time.time()

        for budget in self.budgets:
            # Calculate the time window based on period
            if budget.period == "daily":
                start = now - 86400
            elif budget.period == "weekly":
                start = now - (7 * 86400)
            elif budget.period == "monthly":
                start = now - (30 * 86400)
            else:  # total
                start = 0

            # Query spend for this budget's scope
            calls = self.tracker.get_calls(
                start_time=start,
                end_time=now,
                agent_name=budget.agent_name,
                model=budget.model,
                customer=budget.customer,
            )
            current_spend = sum(c.total_cost for c in calls)
            pct = (current_spend / budget.limit * 100) if budget.limit > 0 else 0

            # Check if we should alert
            should_alert = False
            if pct >= 100 and budget._last_alerted_pct < 100:
                should_alert = True
            elif pct >= budget.alert_at_pct and budget._last_alerted_pct < budget.alert_at_pct:
                should_alert = True

            if should_alert:
                budget._last_alerted_pct = pct
                logger.info(
                    "Budget '%s' at %.1f%% ($%.2f / $%.2f) — alerting",
                    budget.name, pct, current_spend, budget.limit,
                )
                for notifier in self.notifiers:
                    try:
                        notifier.send(budget, current_spend, pct)
                    except Exception as e:
                        logger.error("Notifier %s failed: %s", type(notifier).__name__, e)

            # Update tracking even if we didn't alert (so we know the current state)
            budget._last_alerted_pct = pct

    def start(self, interval_seconds: int = 300):
        """Start background monitoring thread."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="tokimeter-monitor"
        )
        self._thread.start()
        logger.debug("BudgetMonitor started (interval=%ss)", interval_seconds)

    def stop(self, timeout: float = 5.0):
        """Stop background monitoring."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def _run(self):
        while not self._stop_event.is_set():
            try:
                self.check()
            except Exception as e:
                logger.error("Budget check failed: %s", e)
            self._stop_event.wait(timeout=300)  # default 5 min
