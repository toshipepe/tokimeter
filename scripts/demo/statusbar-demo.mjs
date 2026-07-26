// Renders the Tokimeter status-line HUD as it appears live in Claude Code and
// Codex — the inline surface you never have to leave your editor to read.
// Drives demo-inline.gif via vhs. The HUD format and starting figures are the
// real ones the statusline script emits; the short climb is illustrative of
// what happens across a working session (cost rises, the 5-hour window fills,
// the budget warning flips on in place).

const G = '\x1b[38;2;74;222;128m';   // tokimeter green
const D = '\x1b[38;2;107;143;119m';  // muted
const W = '\x1b[38;2;250;204;80m';   // warning amber
const B = '\x1b[1m';
const R = '\x1b[0m';
const BAR = '\x1b[48;2;14;26;20m';   // status-bar background

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => process.stdout.write('\x1b[2J\x1b[H');
const line = (s = '') => process.stdout.write(s + '\n');

// One HUD frame. pct>=80 shows the amber warning, matching the real script.
function hud(tool, today, fivehr, pct, calls, model) {
  const warn = pct >= 80 ? ` ${W}(${pct}% ⚠)${R}` : ` ${D}(${pct}%)${R}`;
  return `${BAR} ${G}Tokimeter ${tool}${R}${BAR} today ${G}~$${today.toFixed(2)}${R}`
    + `${BAR} · 5h ${G}~$${fivehr.toFixed(2)}${R}${BAR}${warn}${BAR} · ${calls} calls · latest ${D}${model}${R}${BAR} \x1b[K${R}`;
}

async function frame(caption, tool, today, fivehr, pct, calls, model) {
  clear();
  line();
  line(`  ${D}Tokimeter lives in your editor's status line — no window to check,${R}`);
  line(`  ${D}no extra model calls. It updates as you work:${R}`);
  line();
  line();
  line(`  ${B}${caption}${R}`);
  line();
  // The status bar, drawn full-width like an editor bottom bar.
  line('  ' + hud(tool, today, fivehr, pct, calls, model));
  line();
}

async function main() {
  // Claude Code — cost climbs and the 5-hour window fills across a session.
  await frame('Claude Code', 'Claude', 23.72, 1.60, 53, 118, 'claude-opus-4-8'); await sleep(1400);
  await frame('Claude Code', 'Claude', 23.72, 2.10, 70, 126, 'claude-opus-4-8'); await sleep(1200);
  await frame('Claude Code · budget warning in place', 'Claude', 23.72, 2.64, 88, 130, 'claude-opus-4-8'); await sleep(1900);
  await frame('Claude Code · over your 5-hour budget', 'Claude', 23.72, 3.18, 106, 134, 'claude-opus-4-8'); await sleep(2100);
  // Codex gets the same HUD via its overlay.
  await frame('Codex — same HUD, same meter', 'Codex', 11.96, 4.02, 48, 207, 'gpt-5.6-terra'); await sleep(2000);
  // Close on the calm state + the setup line.
  clear();
  line();
  line(`  ${G}${B}One meter, in every editor.${R}`);
  line();
  line(`  ${D}Turn it on:${R}  ${G}tokimeter setup --auto${R}`);
  line(`  ${D}Live feed:${R}   ${G}tokimeter watch${R}`);
  line();
  await sleep(2200);
}

main();
