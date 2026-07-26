"""
Web dashboard for Tokimeter.

Self-contained dark-themed dashboard using Python's built-in HTTP server.
Zero frontend dependencies — pure HTML/CSS/JS served from a single endpoint.

Usage:
    from tokimeter.dashboard import launch_dashboard
    launch_dashboard(db_path="tokimeter.db", port=8747)
"""

from __future__ import annotations

import json
import time
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .core import Tracker
from .optimizer import Optimizer


DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tokimeter — LLM Cost Intelligence</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
    --cyan: #39c5cf; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5; font-size: 14px;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.6rem; font-weight: 600; }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 20px; border-bottom: 1px solid var(--border); margin-bottom: 24px;
  }
  .logo { display: flex; align-items: center; gap: 10px; }
  .logo-icon { font-size: 1.5rem; }
  .refresh-btn {
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85rem;
  }
  .refresh-btn:hover { border-color: var(--accent); }

  /* KPI cards */
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
  .kpi-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px;
  }
  .kpi-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin-bottom: 8px; }
  .kpi-value { font-size: 1.8rem; font-weight: 700; }
  .kpi-sub { font-size: 0.8rem; color: var(--dim); margin-top: 4px; }

  /* Sections */
  .section {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; margin-bottom: 16px;
  }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 0.75rem; text-transform: uppercase; color: var(--dim); padding: 8px 0; border-bottom: 1px solid var(--border); }
  td { padding: 10px 0; border-bottom: 1px solid var(--border); }
  td:last-child, th:last-child { text-align: right; }
  .bar-container { display: flex; align-items: center; gap: 8px; }
  .bar { height: 8px; border-radius: 4px; background: var(--accent); min-width: 2px; }

  /* Recommendations */
  .rec { padding: 16px 0; border-bottom: 1px solid var(--border); }
  .rec:last-child { border-bottom: none; }
  .rec-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .badge { font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
  .badge-critical { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-warning { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-info { background: rgba(88,166,255,0.15); color: var(--accent); }
  .rec-savings { color: var(--green); font-weight: 600; }
  .rec-desc { color: var(--dim); font-size: 0.85rem; margin: 4px 0 8px; }
  .rec-action { color: var(--cyan); font-size: 0.85rem; }

  .empty { color: var(--dim); text-align: center; padding: 40px; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">
      <span class="logo-icon"><svg width="22" height="22" viewBox="0 0 64 64" style="vertical-align:-4px"><path d="M15 49 A24 24 0 1 1 49 49" fill="none" stroke="#4ade80" stroke-width="9.5" stroke-linecap="round"/><circle cx="32" cy="56" r="5" fill="#4ade80"/><line x1="32" y1="32" x2="43.5" y2="20.5" stroke="#4ade80" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="32" r="6.5" fill="#4ade80"/></svg></span>
      <h1>Tokimeter</h1>
      <span style="color:var(--dim); font-size:0.85rem; margin-left:8px;">LLM Cost Intelligence</span>
    </div>
    <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
  </div>

  <div id="dashboard">Loading...</div>
</div>

<script>
async function loadData() {
  const resp = await fetch('/api/data');
  const data = await resp.json();
  render(data);
}

function fmt(n) { return '$' + n.toFixed(4); }
function fmtInt(n) { return n.toLocaleString(); }

function render(data) {
  const r = data.report;
  let html = '';

  // KPIs
  const savings = data.recommendations.reduce((s, r) => s + r.estimated_savings_monthly, 0);
  html += '<div class="kpi-grid">';
  html += kpiCard('Total Spend', '$' + r.total_cost.toFixed(2), r.total_calls + ' calls');
  html += kpiCard('Input Cost', '$' + r.total_input_cost.toFixed(2), fmtInt(r.total_input_tokens) + ' tokens');
  html += kpiCard('Output Cost', '$' + r.total_output_cost.toFixed(2), fmtInt(r.total_output_tokens) + ' tokens');
  html += kpiCard('Potential Savings', '<span style="color:var(--green)">$' + savings.toFixed(2) + '/mo</span>',
                   data.recommendations.length + ' recommendations');
  html += '</div>';

  // By Agent
  if (Object.keys(r.by_agent).length > 0) {
    const maxCost = Math.max(...Object.values(r.by_agent));
    html += '<div class="section"><h2>📊 Spend by Agent</h2><table>';
    html += '<tr><th>Agent</th><th>Calls</th><th style="width:40%">Share</th><th>Cost</th></tr>';
    const agentCalls = {};
    data.recent_calls.forEach(c => { agentCalls[c.agent_name] = (agentCalls[c.agent_name] || 0) + 1; });
    Object.entries(r.by_agent).sort((a,b) => b[1]-a[1]).forEach(([agent, cost]) => {
      const pct = (cost / r.total_cost * 100).toFixed(1);
      const barW = (cost / maxCost * 100).toFixed(0);
      html += `<tr><td>${agent}</td><td style="color:var(--dim)">${agentCalls[agent]||0}</td>`
        + `<td><div class="bar-container"><div class="bar" style="width:${barW}%"></div><span style="color:var(--dim);font-size:0.8rem">${pct}%</span></div></td>`
        + `<td style="color:var(--yellow);font-weight:600">${fmt(cost)}</td></tr>`;
    });
    html += '</table></div>';
  }

  // By Model
  if (Object.keys(r.by_model).length > 0) {
    html += '<div class="section"><h2>🤖 Spend by Model</h2><table>';
    html += '<tr><th>Model</th><th>Provider</th><th>Cost</th></tr>';
    const modelProvider = {};
    data.recent_calls.forEach(c => { modelProvider[c.model] = c.provider; });
    Object.entries(r.by_model).sort((a,b) => b[1]-a[1]).forEach(([model, cost]) => {
      html += `<tr><td>${model}</td><td style="color:var(--dim)">${modelProvider[model]||''}</td>`
        + `<td style="color:var(--yellow)">${fmt(cost)}</td></tr>`;
    });
    html += '</table></div>';
  }

  // Daily chart
  if (Object.keys(r.by_day).length > 1) {
    const maxDay = Math.max(...Object.values(r.by_day));
    html += '<div class="section"><h2>📅 Daily Spend</h2>';
    Object.entries(r.by_day).sort().forEach(([day, cost]) => {
      const h = (cost / maxDay * 60).toFixed(0);
      html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">`
        + `<span style="color:var(--dim);width:90px;font-size:0.85rem">${day}</span>`
        + `<div style="height:14px;border-radius:7px;background:var(--accent);width:${h * 3}px;min-width:2px"></div>`
        + `<span style="color:var(--yellow);font-size:0.85rem">${fmt(cost)}</span></div>`;
    });
    html += '</div>';
  }

  // Recommendations
  if (data.recommendations.length > 0) {
    html += '<div class="section"><h2>💡 Recommendations <span style="color:var(--green)">('
      + '$' + savings.toFixed(2) + '/mo potential savings)</span></h2>';
    data.recommendations.forEach(rec => {
      html += `<div class="rec">`
        + `<div class="rec-header">`
        + `<span class="badge badge-${rec.severity}">${rec.severity}</span>`
        + `<strong>${rec.title}</strong>`
        + `<span class="rec-savings" style="margin-left:auto">Save $${rec.estimated_savings_monthly.toFixed(2)}/mo</span>`
        + `</div>`
        + `<div class="rec-desc">${rec.description}</div>`
        + `<div class="rec-action">→ ${rec.action}</div>`
        + `</div>`;
    });
    html += '</div>';
  } else {
    html += '<div class="section"><div class="empty">✓ No optimization opportunities found. Your spend looks efficient.</div></div>';
  }

  // Recent calls
  if (data.recent_calls.length > 0) {
    html += '<div class="section"><h2>📝 Recent Calls</h2><table>';
    html += '<tr><th>Time</th><th>Agent</th><th>Model</th><th>Tokens (in/out)</th><th>Cost</th></tr>';
    data.recent_calls.slice(0, 20).forEach(c => {
      const t = new Date(c.timestamp * 1000).toLocaleString();
      html += `<tr><td style="color:var(--dim);font-size:0.8rem">${t}</td>`
        + `<td>${c.agent_name}</td><td>${c.model}</td>`
        + `<td style="color:var(--dim)">${fmtInt(c.input_tokens)}/${fmtInt(c.output_tokens)}</td>`
        + `<td style="color:var(--yellow)">${fmt(c.total_cost)}</td></tr>`;
    });
    html += '</table></div>';
  }

  document.getElementById('dashboard').innerHTML = html;
}

function kpiCard(label, value, sub) {
  return `<div class="kpi-card"><div class="kpi-label">${label}</div>`
    + `<div class="kpi-value">${value}</div>`
    + `<div class="kpi-sub">${sub}</div></div>`;
}

loadData();
setInterval(loadData, 5000); // auto-refresh every 5s
</script>
</body>
</html>"""


class _DashboardHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the dashboard."""

    tracker: Tracker = None  # set by launch_dashboard

    def log_message(self, format, *args):
        pass  # suppress access logs

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/dashboard":
            self._serve_html()
        elif parsed.path == "/api/data":
            self._serve_api()
        else:
            self.send_error(404)

    def _serve_html(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(DASHBOARD_HTML.encode())

    def _serve_api(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        report = self.tracker.get_report()
        calls = self.tracker.get_calls(limit=500)
        optimizer = Optimizer(self.tracker.pricer)
        recs = optimizer.analyze(calls)

        # Serialize calls for JSON
        call_data = [{
            "timestamp": c.timestamp,
            "provider": c.provider,
            "model": c.model,
            "input_tokens": c.input_tokens,
            "output_tokens": c.output_tokens,
            "total_cost": c.total_cost,
            "agent_name": c.agent_name,
            "workflow": c.workflow,
        } for c in calls]

        rec_data = [{
            "severity": r.severity,
            "title": r.title,
            "description": r.description,
            "estimated_savings_monthly": r.estimated_savings_monthly,
            "action": r.action,
        } for r in recs]

        data = {
            "report": {
                "total_cost": report.total_cost,
                "total_input_cost": report.total_input_cost,
                "total_output_cost": report.total_output_cost,
                "total_calls": report.total_calls,
                "total_input_tokens": report.total_input_tokens,
                "total_output_tokens": report.total_output_tokens,
                "by_agent": report.by_agent,
                "by_model": report.by_model,
                "by_provider": report.by_provider,
                "by_day": report.by_day,
            },
            "recent_calls": call_data,
            "recommendations": rec_data,
        }

        self.wfile.write(json.dumps(data, default=str).encode())


def launch_dashboard(db_path: str = "tokimeter.db", port: int = 8747, open_browser: bool = True):
    """Launch the web dashboard server."""
    tracker = Tracker(db_path=db_path)

    # Attach tracker to handler class
    handler = type("Handler", (_DashboardHandler,), {"tracker": tracker})

    server = HTTPServer(("127.0.0.1", port), handler)

    url = f"http://127.0.0.1:{port}"
    print(f"\n  💰 Tokimeter Dashboard running at {url}")
    print(f"  Press Ctrl+C to stop.\n")

    if open_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Dashboard stopped.")
        server.server_close()
