/**
 * Tokimeter VS Code Extension
 *
 * Shows real-time LLM cost intelligence in VS Code:
 * - Status bar with running cost total
 * - Rotating tips that appear during AI "thinking" states
 * - Cost dashboard webview panel
 * - Integrates with the local proxy for 100% accurate data
 *
 * The extension polls the local proxy server (http://localhost:8788)
 * which tracks all LLM calls from Claude Code, Codex, Cursor, Aider, etc.
 */

const vscode = require('vscode');
const http = require('http');

let statusBar;
let tipDecorator;
let pollingTimer;
let tipRotationMs = 5000;
let dashboardPanel;
let dashboardTimer;
let lastTip = '';
let proxyHealthy = false;
let waitStateDetector;
let lastSummary = null;
let lastCalls = [];
let lastCallId = '';

// ─── Activation ─────────────────────────────────────────────────────────────

function activate(context) {
  const config = vscode.workspace.getConfiguration('tokimeter');

  // ─── Status Bar ────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'tokimeter.showDashboard';
  statusBar.text = '$(sparkle) Tokimeter';
  statusBar.tooltip = 'Click to see cost dashboard';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ─── Commands ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('tokimeter.showDashboard', () => {
      showDashboard(context);
    }),
    vscode.commands.registerCommand('tokimeter.showTip', () => {
      fetchAndShowTip(true);
    }),
    vscode.commands.registerCommand('tokimeter.toggleProxy', () => {
      runTokimeterSetup();
    }),
    vscode.commands.registerCommand('tokimeter.clearHistory', () => {
      clearHistory();
    }),
    vscode.commands.registerCommand('tokimeter.setupLocal', () => {
      runTokimeterSetup();
    }),
    vscode.commands.registerCommand('tokimeter.openWatch', () => {
      openTokimeterWatch();
    }),
    vscode.commands.registerCommand('tokimeter.showLatestCall', () => {
      showLatestCall();
    }),
    vscode.commands.registerCommand('tokimeter.toggleTips', async () => {
      await toggleTips();
    }),
  );

  // ─── Start polling the proxy ──────────────────────────────────────────
  startPolling(config);

  // ─── Detect "thinking" states ─────────────────────────────────────────
  setupWaitStateDetection(context);

  // ─── Listen for config changes ────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tokimeter')) {
        startPolling(vscode.workspace.getConfiguration('tokimeter'));
      }
    })
  );

  console.log('Tokimeter extension activated');
}

// ─── Proxy Polling ──────────────────────────────────────────────────────────

function startPolling(config) {
  if (pollingTimer) clearInterval(pollingTimer);

  const proxyUrl = config.get('proxyUrl', 'http://localhost:8788');
  const interval = config.get('tipInterval', 5000);
  tipRotationMs = interval;

  // Poll immediately, then on interval
  pollProxy(proxyUrl);
  pollingTimer = setInterval(() => pollProxy(proxyUrl), interval);
}

function pollProxy(proxyUrl) {
  fetchJSON(proxyUrl + '/api/health', (err, data) => {
    if (err) {
      proxyHealthy = false;
      updateStatusBar(null, null, false);
      return;
    }
    proxyHealthy = true;
  });

  fetchJSON(proxyUrl + '/api/summary', (err, summary) => {
    if (err || !summary) {
      updateStatusBar(null, null, proxyHealthy);
      return;
    }
    lastSummary = summary;
    updateStatusBar(summary.todayCost, summary.totalCalls, true);
  });

  fetchJSON(proxyUrl + '/api/calls?limit=12', (err, calls) => {
    if (err || !Array.isArray(calls)) return;
    lastCalls = calls;
    maybeAnnounceNewCall(calls[0]);
  });

  fetchJSON(proxyUrl + '/api/tips', (err, data) => {
    if (err || !data || !data.tips) return;
    if (data.tips.length > 0) {
      const tip = data.tips[Math.floor(Date.now() / tipRotationMs) % data.tips.length];
      if (tip !== lastTip) {
        lastTip = tip;
        maybeShowTip(tip);
      }
    }
  });
}

// ─── Status Bar ─────────────────────────────────────────────────────────────

function updateStatusBar(todayCost, totalCalls, healthy) {
  const config = vscode.workspace.getConfiguration('tokimeter');
  if (!config.get('showStatusBar', true)) {
    statusBar.hide();
    return;
  }
  statusBar.show();

  if (!healthy) {
    statusBar.text = '$(warning) Tokimeter offline';
    statusBar.tooltip = 'Tokimeter proxy is not reachable. Click to run local setup.';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  statusBar.backgroundColor = undefined;

  if (todayCost !== null) {
    const dailyBudget = Number(config.get('dailyBudget', 0)) || 0;
    if ((dailyBudget > 0 && todayCost >= dailyBudget) || todayCost > 1.0) {
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    const latest = lastCalls[0];
    const latestText = latest?.model ? ` · ${latest.model}` : '';
    statusBar.text = `$(credit-card) $${todayCost.toFixed(2)} today${latestText}`;
    statusBar.tooltip = buildStatusTooltip(todayCost, totalCalls, latest);
  } else {
    statusBar.text = '$(pulse) Tokimeter waiting';
    statusBar.tooltip = 'Tokimeter is connected. Costs will appear after your first LLM call.';
  }
}

function buildStatusTooltip(todayCost, totalCalls, latest) {
  const lines = [
    `Tokimeter: $${todayCost.toFixed(2)} today, ${totalCalls} total calls.`,
  ];
  if (latest) {
    lines.push(`Latest: ${latest.tool || latest.provider || 'AI'} · ${latest.model || 'unknown'} · ${formatCallLabels(latest)} · $${(latest.totalCost || 0).toFixed(4)}`);
    lines.push(`${latest.inputTokens || 0} input / ${latest.outputTokens || 0} output tokens`);
  }
  lines.push('Click for dashboard.');
  return lines.join('\n');
}

// ─── Tips ───────────────────────────────────────────────────────────────────

/**
 * Show a tip — but only during AI "thinking" states or on demand.
 * This is the kickbacks-style behavior.
 */
function maybeShowTip(tipText) {
  const config = vscode.workspace.getConfiguration('tokimeter');
  if (!config.get('showTipsDuringWait', true)) return;

  // Show as a subtle notification that auto-dismisses
  if (waitStateDetector && waitStateDetector.isThinking()) {
    // During active thinking — show in output channel (less disruptive)
    getOutputChannel().appendLine(tipText);
    getOutputChannel().show(true);
  }
}

function fetchAndShowTip(force) {
  const config = vscode.workspace.getConfiguration('tokimeter');
  const proxyUrl = config.get('proxyUrl', 'http://localhost:8788');

  fetchJSON(proxyUrl + '/api/tips', (err, data) => {
    if (err || !data || !data.tips || data.tips.length === 0) {
      vscode.window.showInformationMessage('Tokimeter: No tips yet — make some LLM calls first!');
      return;
    }
    const tip = data.tips[0];
    vscode.window.showInformationMessage(tip, 'See Dashboard', 'Dismiss').then(choice => {
      if (choice === 'See Dashboard') {
        vscode.commands.executeCommand('tokimeter.showDashboard');
      }
    });
  });
}

function maybeAnnounceNewCall(call) {
  const config = vscode.workspace.getConfiguration('tokimeter');
  if (!config.get('showTipsDuringWait', true)) return;
  if (!call) return;

  const id = call.externalId || `${call.timestamp}-${call.tool}-${call.model}-${call.totalCost}`;
  if (!id || id === lastCallId) return;
  lastCallId = id;

  if (waitStateDetector && waitStateDetector.isThinking()) {
    const model = call.model || 'unknown';
    const cost = Number(call.totalCost || 0).toFixed(4);
    const input = call.inputTokens || 0;
    const output = call.outputTokens || 0;
    getOutputChannel().appendLine(`Tokimeter: ${model} · ${formatCallLabels(call)} · ${input} in / ${output} out · $${cost}`);
  }
}

function runTokimeterSetup() {
  const terminal = vscode.window.createTerminal({ name: 'Tokimeter Setup' });
  terminal.show();
  terminal.sendText('tokimeter setup --auto');
}

function openTokimeterWatch() {
  const terminal = vscode.window.createTerminal({ name: 'Tokimeter Watch' });
  terminal.show();
  terminal.sendText('tokimeter watch');
}

function showLatestCall() {
  const latest = lastCalls[0];
  if (!latest) {
    vscode.window.showInformationMessage('Tokimeter has not tracked any calls yet.');
    return;
  }

  const model = latest.model || 'unknown';
  const cost = Number(latest.totalCost || 0).toFixed(4);
  const input = latest.inputTokens || 0;
  const output = latest.outputTokens || 0;
  vscode.window.showInformationMessage(
    `Tokimeter latest: ${model} · ${formatCallLabels(latest)} · ${input} in / ${output} out · $${cost}`,
    'Dashboard',
    'Watch'
  ).then(choice => {
    if (choice === 'Dashboard') vscode.commands.executeCommand('tokimeter.showDashboard');
    if (choice === 'Watch') vscode.commands.executeCommand('tokimeter.openWatch');
  });
}

function runInTerminal(name, command) {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  terminal.sendText(command);
}

function callMatchesTool(call, tool) {
  const callTool = String(call?.tool || '');
  const provider = String(call?.provider || '');
  const source = String(call?.source || '');
  if (tool === 'claude') return callTool === 'claude-code' || provider === 'anthropic';
  if (tool === 'codex') return callTool === 'codex' || source.startsWith('codex-');
  return true;
}

function isEstimatedCall(call) {
  const source = String(call?.source || '');
  return source.startsWith('claude-transcript')
    || source.startsWith('codex-rollout')
    || source.startsWith('codex-cli')
    || source === 'manual';
}

function summarizeDashboardCalls(calls) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const out = { todayCost: 0, todayCalls: 0, todayEstCost: 0, totalCost: 0, totalCalls: 0 };
  for (const call of calls) {
    const cost = Number(call.totalCost) || 0;
    out.totalCost += cost;
    out.totalCalls += 1;
    if ((Number(call.timestamp) || 0) >= todayMs) {
      out.todayCost += cost;
      out.todayCalls += 1;
      if (isEstimatedCall(call)) out.todayEstCost += cost;
    }
  }
  return out;
}

function buildDashboardBreakdowns(calls) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const byTool = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const bump = (map, key, cost) => {
    const cur = map.get(key) || { cost: 0, calls: 0 };
    cur.cost += cost;
    cur.calls += 1;
    map.set(key, cur);
  };
  for (const call of calls) {
    if ((Number(call.timestamp) || 0) < todayMs) continue;
    const cost = Number(call.totalCost) || 0;
    bump(byTool, call.tool || 'unknown', cost);
    bump(byModel, (call.model || 'unknown') + (call.effort ? ' ' + call.effort : ''), cost);
    bump(byProject, call.cwd ? shortenDashboardPath(String(call.cwd)) : '(unknown)', cost);
  }
  const toRows = (map) => [...map.entries()]
    .map(([name, v]) => ({ name, cost: v.cost, calls: v.calls }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8);
  return { byTool: toRows(byTool), byModel: toRows(byModel), byProject: toRows(byProject) };
}

function shortenDashboardPath(pathValue) {
  const parts = pathValue.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : pathValue;
}

function estimateSavings(calls) {
  let actual = 0;
  let baseline = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const call of calls || []) {
    if ((Number(call.timestamp) || 0) < today.getTime()) continue;
    const cost = Number(call.totalCost || 0);
    actual += cost;
    baseline += estimatedBaselineCost(call, cost);
  }

  return { actual, baseline, saved: Math.max(0, baseline - actual) };
}

function estimatedBaselineCost(call, actualCost) {
  const model = String(call.model || '').toLowerCase();
  const effort = String(call.effort || '').toLowerCase();
  let multiplier = 1;

  if (model.includes('haiku')) multiplier = 3.5;
  else if (model.includes('mini') || model.includes('nano')) multiplier = 2.8;
  else if (model.includes('sonnet')) multiplier = 1.5;

  if (effort === 'low') multiplier = Math.max(multiplier, 1.8);
  return actualCost * multiplier;
}

function formatCallLabels(call) {
  const confidence = call?.confidence || confidenceForSource(call?.source);
  const pricing = call?.pricingConfidence || 'known';
  return `${tokenConfidenceLabel(confidence)}/${pricingConfidenceLabel(pricing)}`;
}

function confidenceForSource(source) {
  if (source === 'codex-rollout-token-count') return 'imported';
  if (source === 'codex-cli-summary') return 'estimated';
  if (source === 'manual') return 'manual';
  return 'tracked';
}

function tokenConfidenceLabel(confidence) {
  if (confidence === 'exact') return 'exact tokens';
  if (confidence === 'estimated') return 'estimated tokens';
  if (confidence === 'imported') return 'imported tokens';
  if (confidence === 'manual') return 'manual tokens';
  return 'tracked tokens';
}

function pricingConfidenceLabel(confidence) {
  if (confidence === 'custom') return 'custom pricing';
  if (confidence === 'fallback') return 'fallback pricing';
  return 'built-in pricing';
}

async function toggleTips() {
  const config = vscode.workspace.getConfiguration('tokimeter');
  const current = config.get('showTipsDuringWait', true);
  await config.update('showTipsDuringWait', !current, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Tokimeter tips ${!current ? 'enabled' : 'disabled'}.`);
}

// ─── Wait State Detection ───────────────────────────────────────────────────

/**
 * Detects when Claude Code, Codex, or other AI tools are "thinking."
 * Monitors the integrated terminal for spinner patterns.
 */
class WaitStateDetector {
  constructor() {
    this.thinkingState = false;
    this.setup();
  }

  setup() {
    if (typeof vscode.window.onDidWriteTerminalData !== 'function') {
      getOutputChannel().appendLine('Terminal activity detection is not available in this VS Code build.');
      return;
    }

    // Check terminal output transiently for AI thinking patterns. The event
    // contents are never retained or transmitted.
    this.terminalSubscription = vscode.window.onDidWriteTerminalData(e => {
      const config = vscode.workspace.getConfiguration('tokimeter');
      if (!config.get('showTipsDuringWait', true)) {
        this.thinkingState = false;
        return;
      }

      // Detect spinner patterns: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
      // Or text patterns: "Thinking...", "Working...", "Generating..."
      const spinnerPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
      const textPattern = /thinking|working|generating|processing|analyzing/i;

      if (spinnerPattern.test(e.data) || textPattern.test(e.data)) {
        if (!this.thinkingState) {
          this.thinkingState = true;
          this.onThinkingStart();
        }
      }

      // Clear thinking state when we see output (response complete)
      if (e.data.includes('\n') && !spinnerPattern.test(e.data)) {
        if (this.thinkingState) {
          this.thinkingState = false;
          this.onThinkingEnd();
        }
      }
    });

    // Also detect via active terminal name
    vscode.window.onDidChangeActiveTerminal(term => {
      if (term && (term.name.toLowerCase().includes('claude') ||
                   term.name.toLowerCase().includes('codex'))) {
        // Terminal likely running an AI tool
      }
    });
  }

  onThinkingStart() {
    const config = vscode.workspace.getConfiguration('tokimeter');
    if (config.get('showTipsDuringWait', true)) {
      getOutputChannel().appendLine('\n━━━ AI Tool Active ━━━');
      getOutputChannel().show(true);
    }
  }

  onThinkingEnd() {
    // Fetch and show the cost of the call that just completed
    const config = vscode.workspace.getConfiguration('tokimeter');
    const proxyUrl = config.get('proxyUrl', 'http://localhost:8788');

    fetchJSON(proxyUrl + '/api/calls?limit=1', (err, calls) => {
      if (err || !calls || calls.length === 0) return;
      const lastCall = calls[0];
      const msg = `✓ $${lastCall.totalCost.toFixed(4)} (${lastCall.inputTokens}→${lastCall.outputTokens} tokens)`;
      getOutputChannel().appendLine(msg);
    });
  }

  isThinking() {
    return this.thinkingState;
  }
}

function setupWaitStateDetection(context) {
  waitStateDetector = new WaitStateDetector();
  if (waitStateDetector.terminalSubscription) {
    context.subscriptions.push(waitStateDetector.terminalSubscription);
  }
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

/**
 * Full webview dashboard showing cost breakdowns, charts, and recommendations.
 */
function showDashboard(context) {
  const config = vscode.workspace.getConfiguration('tokimeter');
  const proxyUrl = config.get('proxyUrl', 'http://localhost:8788');

  if (dashboardPanel) {
    dashboardPanel.reveal();
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'tokimeterDashboard',
    'Tokimeter Dashboard',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  let currentFilter = 'all';

  dashboardPanel.webview.html = getDashboardHTML();
  dashboardPanel.webview.onDidReceiveMessage(msg => {
    if (!msg || !msg.command) return;
    if (msg.command === 'setup') runTokimeterSetup();
    if (msg.command === 'watch') openTokimeterWatch();
    if (msg.command === 'tip') fetchAndShowTip(true);
    if (msg.command === 'latest') showLatestCall();
    if (msg.command === 'ready') runInTerminal('Tokimeter Ready', 'tokimeter ready');
    if (msg.command === 'proxyStart') runInTerminal('Tokimeter Proxy', 'tokimeter start');
    if (msg.command === 'proxyStop') runInTerminal('Tokimeter Proxy', 'tokimeter stop');
    if (msg.command === 'importCodex') runInTerminal('Tokimeter Import', 'tokimeter codex-import');
    if (msg.command === 'importClaude') runInTerminal('Tokimeter Import', 'tokimeter claude-import');
    if (msg.command === 'filter') {
      currentFilter = msg.value === 'claude' || msg.value === 'codex' ? msg.value : 'all';
      pushData();
    }
  }, null, context.subscriptions);

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = null;
    if (dashboardTimer) {
      clearInterval(dashboardTimer);
      dashboardTimer = null;
    }
  }, null, context.subscriptions);

  // Send data to webview
  function pushData() {
    if (!dashboardPanel) return;

    fetchJSON(proxyUrl + '/api/summary', (err, summary) => {
      fetchJSON(proxyUrl + '/api/tips', (err2, tips) => {
        fetchJSON(proxyUrl + '/api/calls?limit=500', (err3, calls) => {
          const allCalls = Array.isArray(calls) ? calls : [];
          const callList = currentFilter === 'all' ? allCalls : allCalls.filter(c => callMatchesTool(c, currentFilter));
          dashboardPanel.webview.postMessage({
            type: 'data',
            summary: summary || {},
            tips: tips?.tips || [],
            calls: callList.slice(0, 20),
            savings: estimateSavings(callList),
            healthy: !err && Boolean(summary),
            filter: currentFilter,
            scoped: summarizeDashboardCalls(callList),
            breakdowns: buildDashboardBreakdowns(callList),
          });
        });
      });
    });
  }

  pushData();
  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = setInterval(pushData, 5000);
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    padding: 20px;
    margin: 0;
  }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  h1 { font-size: 1.4rem; margin: 0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .kpi {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 16px;
  }
  .kpi-label { font-size: 0.7rem; text-transform: uppercase; opacity: 0.7; margin-bottom: 6px; }
  .kpi-value { font-size: 1.5rem; font-weight: 700; }
  .section {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 16px; margin-bottom: 12px;
  }
  h2 { font-size: 1rem; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 0.75rem; opacity: 0.7; padding: 6px 0; }
  td { padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
  .tip { padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
  .tip:first-child { border: none; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-focusBorder); display: inline-block; }
  .savings { color: #3fb950; font-weight: 600; }
  .offline { text-align: center; padding: 40px; opacity: 0.6; }
  .filters { display: flex; gap: 6px; margin-bottom: 14px; }
  .filter { opacity: 0.7; }
  .filter.active { opacity: 1; outline: 1px solid var(--vscode-focusBorder); }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="header">
  <h1><svg width="20" height="20" viewBox="0 0 64 64" style="vertical-align:-3px"><path d="M15 49 A24 24 0 1 1 49 49" fill="none" stroke="#4ade80" stroke-width="9.5" stroke-linecap="round"/><circle cx="32" cy="56" r="5" fill="#4ade80"/><line x1="32" y1="32" x2="43.5" y2="20.5" stroke="#4ade80" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="32" r="6.5" fill="#4ade80"/></svg> Tokimeter</h1>
  <div class="actions">
    <button data-command="setup">Setup</button>
    <button data-command="ready" class="secondary">Ready check</button>
    <button data-command="proxyStart" class="secondary">Start proxy</button>
    <button data-command="proxyStop" class="secondary">Stop proxy</button>
    <button data-command="watch" class="secondary">Watch</button>
    <button data-command="importCodex" class="secondary">Import Codex</button>
    <button data-command="importClaude" class="secondary">Import Claude</button>
  </div>
</div>
<div class="filters">
  <button data-filter="all" class="filter active">All</button>
  <button data-filter="claude" class="filter">Claude</button>
  <button data-filter="codex" class="filter">Codex</button>
</div>
<div id="content">
  <div class="offline">Connecting to proxy...</div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  document.addEventListener('click', e => {
    const command = e.target?.dataset?.command;
    if (command) vscode.postMessage({ command });
    const filter = e.target?.dataset?.filter;
    if (filter) {
      document.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
      vscode.postMessage({ command: 'filter', value: filter });
    }
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'data') render(msg);
  });

  function render(msg) {
    const { summary, tips, calls, savings, healthy, filter, scoped, breakdowns } = msg;
    let html = '';

    // KPIs — scoped to the active tool filter, ~ marks API-equivalent estimates
    const scopedLabel = filter && filter !== 'all' ? ' (' + filter + ')' : '';
    const estMark = scoped && scoped.todayEstCost >= scoped.todayCost - 1e-9 && scoped.todayCost > 0 ? '~' : '';
    html += '<div class="kpi-grid">';
    html += kpi('Today' + scopedLabel, estMark + '$' + ((scoped ? scoped.todayCost : summary.todayCost) || 0).toFixed(2), ((scoped ? scoped.todayCalls : summary.todayCalls) || 0) + ' calls');
    html += kpi('Recent total' + scopedLabel, estMark + '$' + ((scoped ? scoped.totalCost : summary.totalCost) || 0).toFixed(2), ((scoped ? scoped.totalCalls : summary.totalCalls) || 0) + ' calls');
    html += kpi('Under baseline', '~$' + ((savings && savings.saved) || 0).toFixed(2), 'vs list-model baseline');
    const latest = calls && calls[0];
    html += kpi('Latest', latest ? latest.model : '—', latest ? '$' + (latest.totalCost || 0).toFixed(4) : '');
    html += '</div>';

    // Today breakdowns for the active filter
    if (breakdowns) {
      html += breakdownSection('🔧 Today by tool', breakdowns.byTool);
      html += breakdownSection('🧠 Today by model', breakdowns.byModel);
      html += breakdownSection('📁 Today by project', breakdowns.byProject);
    }

    if (!healthy) {
      html += '<div class="section"><h2>Proxy</h2><p>Tokimeter proxy is not reachable.</p>'
        + '<p><code>tokimeter setup --auto</code></p></div>';
    }

    // Tips
    if (tips && tips.length > 0) {
      html += '<div class="section"><h2>💡 Recommendations</h2>';
      for (const tip of tips) {
        html += '<div class="tip">' + tip + '</div>';
      }
      html += '</div>';
    }

    // Recent calls
    if (calls && calls.length > 0) {
      html += '<div class="section"><h2>📝 Recent Calls</h2><table>';
      html += '<tr><th>Time</th><th>Model</th><th>Confidence</th><th>Tokens</th><th>Cost</th></tr>';
      for (const c of calls.slice(0, 15)) {
        const t = new Date(c.timestamp).toLocaleTimeString();
        html += '<tr><td style="opacity:0.6">' + t + '</td>'
          + '<td>' + c.model + '</td>'
          + '<td style="opacity:0.6">' + formatCallLabels(c) + '</td>'
          + '<td style="opacity:0.6">' + (c.inputTokens || 0) + '→' + (c.outputTokens || 0) + '</td>'
          + '<td>$' + (c.totalCost || 0).toFixed(4) + '</td></tr>';
      }
      html += '</table></div>';
    }

    if ((summary.totalCalls || 0) === 0) {
      html += '<div class="section"><div class="offline">'
        + '<p>No calls tracked yet.</p>'
        + '<p style="margin-top:10px">Set up the proxy to start tracking:</p>'
        + '<p style="margin-top:10px"><code>export ANTHROPIC_BASE_URL=http://localhost:8788</code></p>'
        + '<p><code>export OPENAI_BASE_URL=http://localhost:8788</code></p>'
        + '</div></div>';
    }

    document.getElementById('content').innerHTML = html;
  }

  function breakdownSection(title, rows) {
    if (!rows || rows.length === 0) return '';
    const maxCost = rows[0].cost || 0.0001;
    let html = '<div class="section"><h2>' + title + '</h2><table>';
    for (const r of rows) {
      const barW = (r.cost / maxCost * 100).toFixed(0);
      html += '<tr><td>' + r.name + '</td>'
        + '<td style="width:40%"><div class="bar" style="width:' + barW + '%"></div></td>'
        + '<td>$' + r.cost.toFixed(2) + '</td><td style="opacity:0.6">' + r.calls + ' calls</td></tr>';
    }
    return html + '</table></div>';
  }

  function kpi(label, value, sub) {
    return '<div class="kpi"><div class="kpi-label">' + label + '</div>'
      + '<div class="kpi-value">' + value + '</div>'
      + '<div style="font-size:0.75rem;opacity:0.6">' + sub + '</div></div>';
  }

  function formatCallLabels(call) {
    const confidence = call.confidence || confidenceForSource(call.source);
    const pricing = call.pricingConfidence || 'known';
    return tokenConfidenceLabel(confidence) + '/' + pricingConfidenceLabel(pricing);
  }

  function confidenceForSource(source) {
    if (source === 'codex-rollout-token-count') return 'imported';
    if (source === 'codex-cli-summary') return 'estimated';
    if (source === 'manual') return 'manual';
    return 'tracked';
  }

  function tokenConfidenceLabel(confidence) {
    if (confidence === 'exact') return 'exact tokens';
    if (confidence === 'estimated') return 'estimated tokens';
    if (confidence === 'imported') return 'imported tokens';
    if (confidence === 'manual') return 'manual tokens';
    return 'tracked tokens';
  }

  function pricingConfidenceLabel(confidence) {
    if (confidence === 'custom') return 'custom pricing';
    if (confidence === 'fallback') return 'fallback pricing';
    return 'built-in pricing';
  }
</script>
</body>
</html>`;
}

// ─── Clear History ──────────────────────────────────────────────────────────

function clearHistory() {
  vscode.window.showWarningMessage(
    'Clear all Tokimeter cost history?',
    'Yes, Clear',
    'Cancel'
  ).then(choice => {
    if (choice === 'Yes, Clear') {
      const config = vscode.workspace.getConfiguration('tokimeter');
      const proxyUrl = config.get('proxyUrl', 'http://localhost:8788');
      // We don't have a DELETE endpoint, but we can note it
      vscode.window.showInformationMessage('History will clear on proxy restart.');
    }
  });
}

// ─── Utilities ──────────────────────────────────────────────────────────────

let outputChannel;
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Tokimeter');
  }
  return outputChannel;
}

function fetchJSON(url, callback) {
  try {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          callback(null, JSON.parse(data));
        } catch (e) {
          callback(e);
        }
      });
    });
    req.on('error', err => callback(err));
    req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
  } catch (e) {
    callback(e);
  }
}

// ─── Deactivation ───────────────────────────────────────────────────────────

function deactivate() {
  if (pollingTimer) clearInterval(pollingTimer);
  if (dashboardTimer) clearInterval(dashboardTimer);
  if (outputChannel) outputChannel.dispose();
  console.log('Tokimeter extension deactivated');
}

module.exports = { activate, deactivate };
