#!/bin/zsh
# Update Claude Code with a visible download progress bar, and auto-restore the
# known-good 2.1.165 backup if the update leaves the install broken.
set -e
BASE=~/.nvm/versions/node/v24.8.0/lib/node_modules/@anthropic-ai
BIN=~/.nvm/versions/node/v24.8.0/bin
BACKUP=~/.claude-code-2.1.165-working.bin

echo "==> latest version on npm:"
VER=$(npm view @anthropic-ai/claude-code version 2>/dev/null)
echo "    $VER"

echo "==> downloading native macOS-arm64 binary (progress + speed below):"
URL=$(npm view "@anthropic-ai/claude-code-darwin-arm64@${VER}" dist.tarball 2>/dev/null)
echo "    $URL"
# curl WITHOUT -s shows the live progress meter: % / size / speed / ETA
curl -L "$URL" -o /tmp/cc-native.tgz
echo "==> download done ($(du -h /tmp/cc-native.tgz | cut -f1))"

echo "==> installing globally via npm (lets postinstall wire the binary):"
npm install -g "@anthropic-ai/claude-code@${VER}" --foreground-scripts || true

echo "==> verifying claude works (12s watchdog)..."
zsh -i -l -c 'claude --version' > /tmp/cc-verify.out 2>&1 &
pid=$!
( sleep 12; kill -9 $pid 2>/dev/null ) &
wd=$!
wait $pid 2>/dev/null && code=0 || code=1
kill -9 $wd 2>/dev/null || true
OUT=$(cat /tmp/cc-verify.out | tail -1)

if echo "$OUT" | grep -q "Claude Code"; then
  echo "UPDATE_OK :: $OUT"
else
  echo "UPDATE_BROKEN (output: '$OUT') -> restoring 2.1.165 backup"
  cp "$BACKUP" "$BASE/claude-code/bin/claude.exe"
  chmod 755 "$BASE/claude-code/bin/claude.exe"
  ln -sf "../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$BIN/claude"
  rm -rf "$BASE"/.claude-code-* 2>/dev/null || true
  echo "RESTORED :: $(zsh -i -l -c 'claude --version' 2>/dev/null | tail -1)"
fi
