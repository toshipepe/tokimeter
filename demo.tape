# Tokimeter demo gif — render with:
#   node demo/generate-demo-data.mjs && vhs demo.tape     (brew install vhs)
# Produces demo.gif for the README.
#
# The recording runs against the fully synthetic home in demo/home/ —
# no real usage, project names, or budgets ever appear on screen.

Output demo.gif

Set FontSize 15
Set Width 1000
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 12
Set Shell "bash"

# Invisible setup: point every tool home at the synthetic demo data and make
# the typed `npx tokimeter` resolve to the local checkout (pre-publish safe).
Hide
Type `export CLAUDE_HOME="$PWD/demo/home/.claude" CODEX_HOME="$PWD/demo/home/.codex" GROK_HOME="$PWD/demo/home/.grok" HERMES_HOME="$PWD/demo/home/.hermes" TOKIMETER_DATA_DIR="$PWD/demo/home/.tokimeter"`
Enter
Type `npx() { shift; node "$PWD/ts/packages/proxy/src/cli.js" "$@"; }; tokimeter() { node "$PWD/ts/packages/proxy/src/cli.js" "$@"; }`
Enter
Type "clear"
Enter
Show

Type "npx tokimeter report --days=7"
Sleep 500ms
Enter
Sleep 5s

Type "tokimeter limits"
Sleep 500ms
Enter
Sleep 5s

Type "tokimeter compare"
Sleep 500ms
Enter
Sleep 5s
