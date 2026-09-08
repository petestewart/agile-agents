# Temporarily set Codex approval policy to "untrusted" and see whether codex-acp raises permission requests.
cfg="$HOME/.codex/config.toml"
if [ -f "$cfg" ]; then cp "$cfg" "$cfg.agile-bak"; had=1; else mkdir -p "$HOME/.codex"; had=0; fi
restore() { if [ "$had" = 1 ]; then mv -f "$cfg.agile-bak" "$cfg"; else rm -f "$cfg"; fi; echo "config.toml restored"; }
trap restore EXIT
echo "--- existing config.toml (top-level keys) ---"; grep -E '^(approval_policy|sandbox_mode)' "$cfg" 2>/dev/null || echo "(none)"
# If the keys already exist, replace them; else append.
if grep -qE '^approval_policy' "$cfg" 2>/dev/null; then sed -i '' 's/^approval_policy.*/approval_policy = "untrusted"/' "$cfg"; else printf '\napproval_policy = "untrusted"\n' >> "$cfg"; fi
if grep -qE '^sandbox_mode' "$cfg" 2>/dev/null; then sed -i '' 's/^sandbox_mode.*/sandbox_mode = "workspace-write"/' "$cfg"; else printf 'sandbox_mode = "workspace-write"\n' >> "$cfg"; fi
echo "--- running with approval_policy=untrusted ---"
bun permission-matrix.ts --vendor codex --scenario perm --out spike-out/codex-untrusted
