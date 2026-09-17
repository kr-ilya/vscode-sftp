#!/usr/bin/env bash
#
# Runs the test suites, and looks after the servers the contract suite needs.
#
#   scripts/test.sh            ask what to run
#   scripts/test.sh unit       everything that needs nothing but node
#   scripts/test.sh contract   the contract suite against real SFTP and FTP
#   scripts/test.sh all        both
#   scripts/test.sh gate       what the release workflow runs, in its order
#   scripts/test.sh watch      re-run on save
#   scripts/test.sh coverage   with a coverage report
#   scripts/test.sh up|down    only start or stop the servers
#
# Works in Git Bash on Windows as well as in a POSIX shell.

set -eu

cd "$(dirname "$0")/.."

# Git Bash rewrites anything that looks like a path when calling a Windows
# binary, which mangles docker's arguments.
export MSYS_NO_PATHCONV=1

COMPOSE_FILE="test/fixtures/docker/docker-compose.yml"

# The comment block at the top of this file, minus its hashes.
usage() { sed -n '3,${/^#/!q; s/^# \{0,1\}//p;}' "$0"; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

running() {
  id="$(compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = "true" ]
}

servers_up() {
  if ! have_docker; then
    fail "Docker is not running. The contract suite needs a real SFTP and FTP server."
    return 1
  fi

  # The FTP image cannot be restarted -- its entrypoint creates the account and
  # fails with "user in use" the second time -- so a stopped one is removed
  # rather than started.
  if ! running ftp; then
    compose rm -sf ftp >/dev/null 2>&1 || true
  fi

  step "Starting the test servers"
  compose up -d --wait
  compose ps --format 'table {{.Service}}\t{{.Status}}'
}

servers_down() {
  have_docker || return 0
  step "Stopping the test servers"
  compose down
}

unit() {
  step "Unit tests"
  npm test
}

contract() {
  servers_up
  step "Contract suite against the running servers"
  SYNCX_CONTRACT_SFTP=1 SYNCX_CONTRACT_FTP=1 npx vitest run test/contract
}

all() {
  servers_up
  step "Every test, contract suite included"
  SYNCX_CONTRACT_SFTP=1 SYNCX_CONTRACT_FTP=1 npm test
}

gate() {
  step "Lint"
  npm run lint
  step "Types"
  npm run typecheck
  step "Core stays free of the editor API"
  npm run check:core
  step "The generated schema is current"
  npm run gen:schema:check
  unit
  step "The packaged bundle loads"
  npm run smoke
  bold ""
  bold "Everything the release workflow checks has passed."
}

pattern() {
  printf 'File or name to match (e.g. transferGroup, or "batch"): '
  read -r match
  [ -n "$match" ] || { fail "Nothing given."; return 1; }
  step "Tests matching $match"
  # Matches a path when it looks like one, otherwise a test name.
  case "$match" in
    */*|*.spec.ts) npx vitest run "$match" ;;
    *) npx vitest run -t "$match" ;;
  esac
}

menu() {
  bold "SyncX tests"
  cat <<'CHOICES'

  1  Unit tests                  fast, needs nothing
  2  Everything, servers included   unit + contract
  3  Contract suite only         against real SFTP and FTP
  4  Watch                       re-runs on save
  5  One file, or one name
  6  Coverage
  7  Full gate                   what the release workflow runs
  8  Start the servers
  9  Stop the servers
  0  Quit

CHOICES
  printf 'Choice: '
  read -r choice
  case "$choice" in
    1) unit ;;
    2) all ;;
    3) contract ;;
    4) step "Watching -- q to quit"; npm run test:watch ;;
    5) pattern ;;
    6) step "Coverage"; npm run test:coverage; bold "Report: coverage/index.html" ;;
    7) gate ;;
    8) servers_up ;;
    9) servers_down ;;
    0|"") exit 0 ;;
    *) fail "No such choice: $choice"; exit 1 ;;
  esac
}

case "${1-}" in
  "") menu ;;
  unit) unit ;;
  contract) contract ;;
  all) all ;;
  gate) gate ;;
  watch) npm run test:watch ;;
  coverage) npm run test:coverage ;;
  up) servers_up ;;
  down) servers_down ;;
  -h|--help|help) usage ;;
  *) fail "Unknown argument: $1"; usage; exit 1 ;;
esac
