#!/usr/bin/env bash
#
# lptrader operations: start / stop / restart / status / logs / doctor
#
# ## Why a script rather than a process manager alone
#
# The bot was previously run inside `tmux`. That loses its scrollback the moment the session ends, dies
# with the machine, restarts nothing, and gives no way to answer "is it running" without attaching. With
# no logs, a crash left nothing to diagnose — which is exactly how this script came to exist.
#
# ## What it guarantees
#
#   * ONE process. A second start refuses rather than running two bots against one SQLite file.
#   * Logs always on disk, timestamped, and rotated by size.
#   * A PID file that reflects reality: a stale one is detected, not trusted.
#   * A graceful stop (SIGTERM) that waits out the cadence in flight, because the first pool scan
#     legitimately takes ~4 minutes and killing it mid-scan is the common case.
#   * `status` answers the operator's real question without attaching to anything.
#
# ## Usage
#
#   ./scripts/lptrader.sh start [--foreground]
#   ./scripts/lptrader.sh stop|restart|status|logs|tail|doctor

set -euo pipefail

# ---------------------------------------------------------------------------------------------
# Paths and configuration
# ---------------------------------------------------------------------------------------------

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

ENV_FILE="${LP_ENV_FILE:-$APP_DIR/.env}"
RUN_DIR="${LP_RUN_DIR:-$APP_DIR/run}"
LOG_DIR="${LP_LOG_DIR:-$APP_DIR/logs}"
PID_FILE="$RUN_DIR/lptrader.pid"
LOG_FILE="$LOG_DIR/lptrader.log"

# 10 MiB before rotating. A rotating log is what makes "leave it running for a month" possible; the old
# behaviour appended to nothing at all.
LOG_MAX_BYTES="${LP_LOG_MAX_BYTES:-10485760}"

# How long to wait for a graceful stop before insisting.
#
# The process finishes the cadence in flight before exiting — deliberate, so a half-written transaction is
# not left behind — and the FIRST pool scan takes ~4 minutes (the data source rate-limits at 6s/request).
# A shorter timeout therefore kills it mid-scan on the most common stop there is: shortly after start.
STOP_TIMEOUT_SECONDS="${LP_STOP_TIMEOUT:-300}"

readonly C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

# The live PID, or empty. A stale PID file (process gone, or the id reused by something else) is treated as
# absent rather than trusted: acting on a recycled PID would signal an unrelated process.
running_pid() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  # Confirm it is OUR process, not a recycled id. `ps` rather than /proc: /proc is Linux-only, and a
  # script that silently degrades to "not running" on another OS is worse than one that says so.
  if ! ps -p "$pid" -o command= 2>/dev/null | grep -q 'src/main.ts'; then
    return 0
  fi
  printf '%s' "$pid"
}

require_env() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy .env.example and fill it in"
}

# Node and the entry point must both exist; failing here is cheaper than a half-started process.
preflight() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH"
  [ -f "$APP_DIR/src/main.ts" ] || die "src/main.ts not found — is APP_DIR right? ($APP_DIR)"
  [ -d "$APP_DIR/node_modules" ] || die "node_modules missing — run: npm ci"
  require_env
}

# Rotate before appending, so a long-running bot cannot fill the disk.
rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  local size
  size="$(wc -c < "$LOG_FILE" | tr -d ' ')"
  if [ "$size" -ge "$LOG_MAX_BYTES" ]; then
    mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d-%H%M%S)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

cmd_start() {
  preflight
  mkdir -p "$RUN_DIR" "$LOG_DIR"

  local pid
  pid="$(running_pid)"
  if [ -n "$pid" ]; then
    die "already running (pid $pid). Use: $0 restart"
  fi

  if [ "${1:-}" = "--foreground" ]; then
    say "starting in the foreground (Ctrl-C to stop)…"
    exec node --experimental-strip-types --env-file-if-exists="$ENV_FILE" src/main.ts
  fi

  # The passphrase must come from a file: with no TTY the interactive prompt can never be answered and the
  # process would block forever on a prompt nobody can see. Warn early rather than let that happen.
  if grep -qE '^KEYSTORE_PATH=.+' "$ENV_FILE" && ! grep -qE '^KEYSTORE_PASSPHRASE_FILE=.+' "$ENV_FILE"; then
    warn "KEYSTORE_PATH is set but KEYSTORE_PASSPHRASE_FILE is not."
    warn "A background start has no terminal, so the passphrase prompt cannot be answered."
    warn "Set KEYSTORE_PASSPHRASE_FILE in $ENV_FILE (see: $0 doctor), or use: $0 start --foreground"
    exit 1
  fi

  rotate_log

  # Detach from the terminal's session so the process survives the shell that started it.
  #
  # `setsid` is the clean way but is not present everywhere (macOS has no `setsid` binary, and minimal
  # containers often lack it). `nohup` is the portable fallback: it ignores SIGHUP, which is what kills a
  # background process when its shell exits. Detected rather than assumed, because a hard dependency on a
  # missing binary fails at the worst moment — right after the operator believes it started.
  local launcher
  if command -v setsid >/dev/null 2>&1; then
    launcher=(setsid)
  else
    launcher=(nohup)
  fi

  "${launcher[@]}" node --experimental-strip-types --env-file-if-exists="$ENV_FILE" src/main.ts \
    >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  printf '%s' "$new_pid" > "$PID_FILE"

  # Confirm it survived the first moments: a configuration error aborts immediately, and reporting "started"
  # for a process that has already exited is worse than reporting nothing.
  sleep 2
  if ! kill -0 "$new_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    die "process exited immediately. Last lines of $LOG_FILE:
$(tail -20 "$LOG_FILE" 2>/dev/null || true)"
  fi

  ok "started (pid $new_pid)"
  say "log : $LOG_FILE"
  say "follow with: $0 logs -f"
}

cmd_stop() {
  local pid
  pid="$(running_pid)"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    say "not running"
    return 0
  fi

  say "stopping pid $pid (graceful: a cadence in flight is allowed to finish)…"
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$STOP_TIMEOUT_SECONDS" ]; then
      warn "did not stop within ${STOP_TIMEOUT_SECONDS}s — sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  rm -f "$PID_FILE"
  ok "stopped"
  # A hard kill is worth flagging: it can leave a transaction recorded as in-flight when it never was.
  [ "$waited" -lt "$STOP_TIMEOUT_SECONDS" ] || warn "note: it was killed, not stopped. Check tx_records before trusting the position state."
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start "$@"
}

cmd_status() {
  local pid
  pid="$(running_pid)"

  printf '%s\n' "──────────────────────────────────────────────"
  if [ -n "$pid" ]; then
    ok  "process      : running (pid $pid)"
    printf '  uptime     : %s\n' "$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || echo '?')"
    # `%cpu`/`%mem` are not portable across `ps` implementations; CPU time and RSS are.
    printf '  cpu / mem  : %s\n' "$(ps -p "$pid" -o cputime=,rss= 2>/dev/null | tr -s ' ' || echo '?')"
  else
    warn "process      : NOT running"
    [ -f "$PID_FILE" ] && printf '  (stale pid file: %s)\n' "$PID_FILE"
  fi
  printf '%s\n' "──────────────────────────────────────────────"

  # The last cadence line is the single most useful signal: it says whether the scheduler is beating.
  if [ -f "$LOG_FILE" ]; then
    printf 'log          : %s (%s)\n' "$LOG_FILE" "$(du -h "$LOG_FILE" | cut -f1)"
    printf 'last beat    : %s\n' "$(grep -E '\] (pool-scan|portfolio-monitor|pool-health) (ok|FAILED)' "$LOG_FILE" | tail -1 || echo 'none yet')"
    printf 'last error   : %s\n' "$(grep -E 'FAILED|STARTUP ABORTED|Error' "$LOG_FILE" | tail -1 || echo 'none')"
  else
    printf 'log          : %s (not created yet)\n' "$LOG_FILE"
  fi

  # The database answers "is it doing anything" independently of the log.
  local db="$APP_DIR/data/lptrader.db"
  if [ -f "$db" ]; then
    printf 'db snapshots : %s\n' "$(sqlite3 "$db" 'select count(*) from pool_snapshots;' 2>/dev/null || echo '?')"
    printf 'open position: %s\n' "$(sqlite3 "$db" 'select coalesce((select pool_id from positions where closed_at is null limit 1),"none");' 2>/dev/null || echo '?')"
    printf 'pending aprv : %s\n' "$(sqlite3 "$db" "select count(*) from approval_requests where status='pending';" 2>/dev/null || echo '?')"
  else
    printf 'db           : not created yet\n'
  fi
  printf '%s\n' "──────────────────────────────────────────────"
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || die "no log yet at $LOG_FILE"
  if [ "${1:-}" = "-f" ]; then
    tail -f "$LOG_FILE"
  else
    tail -n "${1:-100}" "$LOG_FILE"
  fi
}

# Diagnose the common reasons a start fails, BEFORE it fails again.
cmd_doctor() {
  require_env
  printf '%s\n' "checking $ENV_FILE"

  check() { # name, ok?, detail
    if [ "$2" = "1" ]; then printf '  %s%-24s%s %s\n' "$C_GREEN" "$1" "$C_RESET" "${3:-}";
    else printf '  %s%-24s%s %s\n' "$C_RED" "$1" "$C_RESET" "${3:-}"; fi
  }

  local v

  v="$(grep -cE '^TELEGRAM_BOT_TOKEN=.+' "$ENV_FILE" || true)"
  check "TELEGRAM_BOT_TOKEN" "$v" "$([ "$v" = 1 ] && echo 'set' || echo 'MISSING — without it no build or switch can be approved')"

  v="$(grep -cE '^TELEGRAM_CHAT_ID=.+' "$ENV_FILE" || true)"
  check "TELEGRAM_CHAT_ID" "$v" "$([ "$v" = 1 ] && echo 'set' || echo 'MISSING')"

  v="$(grep -cE '^TELEGRAM_ALLOWED_USER_IDS=.+' "$ENV_FILE" || true)"
  check "TELEGRAM_ALLOWED_USER_IDS" "$v" "$([ "$v" = 1 ] && echo 'set' || echo 'MISSING — nobody could approve')"

  v="$(grep -cE '^KEYSTORE_PATH=.+' "$ENV_FILE" || true)"
  check "KEYSTORE_PATH" "$v" "$([ "$v" = 1 ] && echo 'set' || echo 'not set — read-only monitor')"

  # The passphrase file is what makes a background start possible at all.
  local pf
  pf="$(grep -E '^KEYSTORE_PASSPHRASE_FILE=' "$ENV_FILE" | cut -d= -f2- || true)"
  if [ -n "$pf" ]; then
    if [ ! -f "$pf" ]; then
      check "PASSPHRASE_FILE" 0 "$pf does not exist"
    else
      local mode
      mode="$(stat -c '%a' "$pf" 2>/dev/null || echo '?')"
      if [ "$mode" = "600" ]; then
        check "PASSPHRASE_FILE" 1 "$pf (mode 600)"
      else
        check "PASSPHRASE_FILE" 0 "$pf has mode $mode — must be 600. Run: chmod 600 $pf"
      fi
    fi
  else
    check "PASSPHRASE_FILE" 0 "not set — a background start cannot answer the passphrase prompt"
  fi

  v="$(grep -cE '^DRY_RUN=0' "$ENV_FILE" || true)"
  check "DRY_RUN" 1 "$([ "$v" = 1 ] && echo '0 — transactions WILL be signed' || echo 'not 0 — no transaction will be sent')"

  v="$(grep -cE '^TELEGRAM_ENABLED=true' "$ENV_FILE" || true)"
  check "TELEGRAM_ENABLED" "$v" "$([ "$v" = 1 ] && echo 'true' || echo 'not true — approvals impossible')"

  printf '\n%s\n' "runtime:"
  command -v node >/dev/null && printf '  node %s\n' "$(node --version)" || printf '  %snode missing%s\n' "$C_RED" "$C_RESET"
  [ -d node_modules ] && printf '  node_modules present\n' || printf '  %snode_modules missing — npm ci%s\n' "$C_RED" "$C_RESET"
  command -v sqlite3 >/dev/null && printf '  sqlite3 present\n' || printf '  %ssqlite3 missing — status cannot read the database%s\n' "$C_YELLOW" "$C_RESET"
}

# ---------------------------------------------------------------------------------------------

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_restart "$@" ;;
  status)  cmd_status ;;
  logs)    shift; cmd_logs "$@" ;;
  tail)    cmd_logs -f ;;
  doctor)  cmd_doctor ;;
  *)
    cat <<USAGE
lptrader operations

  $0 start [--foreground]   start in the background (or foreground with a terminal)
  $0 stop                   graceful stop (SIGTERM, then SIGKILL after ${STOP_TIMEOUT_SECONDS}s)
  $0 restart [--foreground] stop then start
  $0 status                 process, last beat, database — without attaching to anything
  $0 logs [n]               last n lines (default 100)
  $0 tail                   follow the log
  $0 doctor                 check the configuration before starting

  env overrides: LP_ENV_FILE LP_RUN_DIR LP_LOG_DIR LP_LOG_MAX_BYTES LP_STOP_TIMEOUT
USAGE
    exit 1 ;;
esac
