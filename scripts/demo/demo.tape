# Hero GIF: zero-setup report + limits. Regenerate: vhs scripts/demo/demo.tape
Output demo.gif
Set FontSize 15
Set Width 1150
Set Height 680
Set Padding 18
Set TypingSpeed 35ms
Set Shell zsh
Hide
Type `npx() { shift; node ts/packages/proxy/src/cli.js "$@"; }`
Enter
Type "clear"
Enter
Show
Sleep 600ms
Type "npx tokimeter report --days=7"
Sleep 400ms
Enter
Sleep 7s
Hide
Type "clear"
Enter
Show
Type "npx tokimeter limits"
Sleep 400ms
Enter
Sleep 6s
