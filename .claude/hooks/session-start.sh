#!/bin/bash
# SessionStart hook — installs Nate's standing Claude Code skill set into remote
# (Claude Code on the web) sessions: find-skills, superpowers, task-observer,
# and the claude-mem plugin. Idempotent and best-effort: a failed install logs
# to stderr but never blocks the session.
set -uo pipefail

# Web sessions only; local machines manage their own ~/.claude.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"

# --- find-skills + superpowers: from the skills.sh registry (npm-based; the
# web sandbox blocks git/API access to out-of-scope GitHub repos, so the
# /plugin marketplace route is not available here).
if [ ! -f "$SKILLS_DIR/find-skills/SKILL.md" ]; then
  npx -y skills add vercel-labs/skills --skill find-skills -a claude-code -g -y \
    || echo "session-start: find-skills install failed" >&2
fi
if [ ! -f "$SKILLS_DIR/using-superpowers/SKILL.md" ]; then
  npx -y skills add obra/superpowers -a claude-code -g -y \
    || echo "session-start: superpowers install failed" >&2
fi

# --- task-observer: ships as a bare SKILL.md; raw.githubusercontent.com is
# reachable from the sandbox even though git clones of the repo are not.
if [ ! -f "$SKILLS_DIR/task-observer/SKILL.md" ]; then
  mkdir -p "$SKILLS_DIR/task-observer"
  for f in SKILL.md USER-GUIDE.md; do
    curl -fsSL --max-time 60 \
      "https://raw.githubusercontent.com/rebelytics/one-skill-to-rule-them-all/main/$f" \
      -o "$SKILLS_DIR/task-observer/$f" \
      || echo "session-start: task-observer $f fetch failed" >&2
  done
fi

# --- claude-mem: npm installer copies the plugin locally, but registers its
# marketplace with a GitHub source the sandbox can't refresh ("cache-miss" on
# load). Re-point the registration at the local copy and supply the
# .claude-plugin/marketplace.json manifest Claude Code expects.
MP="$HOME/.claude/plugins/marketplaces/thedotmack"
if ! claude plugin list 2>/dev/null | grep -q "claude-mem@thedotmack"; then
  npx -y claude-mem install || echo "session-start: claude-mem install failed" >&2
fi
if [ -d "$MP/plugin" ]; then
  mkdir -p "$MP/.claude-plugin"
  cat > "$MP/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "thedotmack",
  "owner": { "name": "Alex Newman" },
  "plugins": [
    {
      "name": "claude-mem",
      "source": "./plugin",
      "description": "Memory compression system for Claude Code - persist context across sessions",
      "category": "Productivity"
    }
  ]
}
JSON
  node -e '
    const fs = require("fs");
    const home = process.env.HOME;
    const p = home + "/.claude/plugins/known_marketplaces.json";
    const mp = home + "/.claude/plugins/marketplaces/thedotmack";
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
    j.thedotmack = {
      source: { source: "directory", path: mp },
      installLocation: mp,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  ' || echo "session-start: claude-mem marketplace repair failed" >&2
  npx -y claude-mem start >/dev/null 2>&1 \
    || echo "session-start: claude-mem worker start failed" >&2
fi

exit 0
