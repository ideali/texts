#!/bin/bash
# SessionStart hook — runs at the beginning of every Claude Code session
# Sets up the environment for both local and cloud (web) sessions

set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Persist environment variables for the session
if [ -n "$CLAUDE_ENV_FILE" ]; then
  cat >> "$CLAUDE_ENV_FILE" << 'VARS'
export QURAN_TRACKER_ROOT="$CLAUDE_PROJECT_DIR/quran-tracker"
export QURAN_WEB="$CLAUDE_PROJECT_DIR/quran-tracker/web"
VARS
fi

# Verify data files exist
if [ ! -f "$PROJECT_DIR/quran-tracker/web/data/quran_full.json" ]; then
  echo "WARNING: quran_full.json not found. Run 'Fetch Quran Data' GitHub Action to download."
fi

# Verify git is configured
git config user.email >/dev/null 2>&1 || git config user.email "claude-code@users.noreply.github.com"
git config user.name >/dev/null 2>&1 || git config user.name "Claude Code"

echo "Quran Tracker environment ready."
exit 0
