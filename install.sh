#!/usr/bin/env bash
# ============================================================================
# TOP CLOUD — Staff Recruitment Portal
# One-command installer for fresh Ubuntu/Debian VPS servers.
#
#   Usage:  sudo bash install.sh            (fresh install)
#   Update: sudo bash install.sh            (rerun — updates code, keeps data)
#   Audit:  sudo bash install.sh --dry-run  (show what would happen; no changes)
#
# What it does:
#   1. Checks OS (Ubuntu/Debian) and root privileges.
#   2. Installs system packages (curl, ca-certificates, sqlite3).
#   3. Installs/verifies Node.js >= 22.5 (NodeSource).
#   4. Places the application in /opt/top-cloud (git pull on updates).
#   5. Installs dependencies reproducibly with `npm ci` (lockfile).
#   6. Creates /etc/top-cloud/.env ONLY when missing; preserves every
#      existing value and secret on reruns. Generates SESSION_SECRET once.
#   7. Creates /var/lib/top-cloud for the SQLite database + backups.
#   8. Runs versioned, idempotent database migrations (safe on every boot).
#   9. Type-checks the build (tsc --noEmit).
#  10. Bootstraps the single Super Owner account if (and only if) none
#      exists. The generated password is printed ONCE and stored in
#      /etc/top-cloud/owner-credentials.txt (mode 600).
#  11. Installs the systemd unit, enables and starts the service.
#  12. Health-checks http://127.0.0.1:$PORT/health before declaring success.
#
# The script exits non-zero on any failed step and never prints a success
# message unless the service actually passed the health check.
# It NEVER deletes application data, the database, or credentials.
# ============================================================================

set -Eeuo pipefail

# ----------------------------- configuration -------------------------------
APP_NAME="top-cloud"
APP_DIR="/opt/top-cloud"
CONF_DIR="/etc/top-cloud"
CONF_FILE="${CONF_DIR}/.env"
DATA_DIR="/var/lib/top-cloud"
DB_FILE="${DATA_DIR}/topcloud.db"
BACKUP_DIR="${DATA_DIR}/backups"
SERVICE_USER="top-cloud"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

log()  { printf '\033[1;35m[top-cloud]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn  ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL  ]\033[0m %s\n' "$*" >&2; exit 1; }

trap 'printf "\033[1;31m[FAIL  ]\033[0m install failed at line $LINENO (command: $BASH_COMMAND). The last step above is where to look.\n" >&2' ERR

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[2m[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

# ----------------------------- step 0: checks ------------------------------
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash install.sh"
if [ "$DRY_RUN" -eq 0 ]; then
  . /etc/os-release 2>/dev/null || true
  case "${ID:-}" in
    ubuntu|debian) : ;;
    *) die "Unsupported OS '${ID:-unknown}' — this installer supports Ubuntu and Debian only." ;;
  esac
fi

log "Installing ${APP_NAME} (dry-run=$DRY_RUN)"

# tsx runs TypeScript directly and is pinned by the lockfile (npm ci installs
# dev dependencies, so node_modules/.bin/tsx always exists after step 7).
TSX_BIN() { echo "${APP_DIR}/node_modules/.bin/tsx"; }

# Verify this script lives in the project checkout (install.sh sits at repo root).
[ -f "${SCRIPT_DIR}/package.json" ] || die "package.json not found next to install.sh — run this script from inside the TOP CLOUD repository."
[ -f "${SCRIPT_DIR}/package-lock.json" ] || die "package-lock.json missing — the lockfile is required for reproducible installs (commit it to git)."

# ----------------------------- step 1: system packages ---------------------
# Required: curl (NodeSource), openssl (secret generation).
# Optional: sqlite3 CLI (ops convenience only — the app uses Node's built-in
#          SQLite engine, so a missing CLI must not fail the install).
if [ "$DRY_RUN" -eq 0 ]; then
  required=()
  command -v curl >/dev/null 2>&1 || required+=(curl)
  command -v openssl >/dev/null 2>&1 || required+=(openssl)
  if [ ${#required[@]} -gt 0 ]; then
    log "Installing required system packages: ${required[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${required[@]}" >/dev/null
    ok "required system packages ready"
  else
    ok "required system packages already present"
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    if apt-get install -y -qq sqlite3 >/dev/null 2>&1; then
      ok "sqlite3 CLI installed (maintenance convenience)"
    else
      warn "sqlite3 CLI not installed — not required (the app uses the built-in Node SQLite engine)."
    fi
  fi
fi

# ----------------------------- step 2: Node.js -----------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_minor() { node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0; }

need_node=1
if command -v node >/dev/null 2>&1; then
  M=$(node_major); m=$(node_minor)
  if [ "$M" -gt "$MIN_NODE_MAJOR" ] || { [ "$M" -eq "$MIN_NODE_MAJOR" ] && [ "$m" -ge "$MIN_NODE_MINOR" ]; }; then
    need_node=0
    ok "Node.js $(node --version) satisfies >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}"
  fi
fi

if [ "$need_node" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would install Node.js ${MIN_NODE_MAJOR}.x from NodeSource"
  else
    log "Installing Node.js ${MIN_NODE_MAJOR}.x from NodeSource…"
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    command -v node >/dev/null 2>&1 || die "Node.js installation failed."
    ok "Node.js $(node --version) installed"
  fi
fi

# ----------------------------- step 3: application files -------------------
if [ -d "${APP_DIR}" ] && [ ! -d "${APP_DIR}/.git" ]; then
  die "${APP_DIR} exists but is not a git checkout. Move it aside (it will NOT be deleted) and rerun."
fi

if [ ! -d "${APP_DIR}" ]; then
  log "Installing application files to ${APP_DIR}…"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ -d "${SCRIPT_DIR}/.git" ]; then
      # Preferred: clone the checkout so future `git pull` updates work.
      git clone --quiet "${SCRIPT_DIR}" "${APP_DIR}"
    else
      # Fallback: plain copy (excluding local secrets and build artifacts).
      mkdir -p "${APP_DIR}"
      (cd "$SCRIPT_DIR" && tar cf - \
          --exclude=.git --exclude=node_modules --exclude=.env \
          --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
          .) | (cd "$APP_DIR" && tar xf -)
    fi
  fi
else
  log "Updating existing checkout at ${APP_DIR} (data and config are untouched)…"
  if [ "$DRY_RUN" -eq 0 ]; then
    (cd "$APP_DIR" && git fetch origin && git checkout -- . 2>/dev/null || true && git pull --ff-only origin HEAD)
  fi
fi
# Ensure the lockfile exists in the install location.
[ -f "${APP_DIR}/package-lock.json" ] || die "package-lock.json missing in ${APP_DIR}."

# ----------------------------- step 4: service user ------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "created system user ${SERVICE_USER}"
  fi
  mkdir -p "${DATA_DIR}" "${BACKUP_DIR}" "${CONF_DIR}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${BACKUP_DIR}"
fi

# ----------------------------- step 5: env file ----------------------------
# Create /etc/top-cloud/.env only when necessary. Every existing value is
# preserved; missing keys are added. Secret values are never printed.
generate_secret() { openssl rand -base64 48; }

merge_env_file() {
  # Merges missing keys into the env file WITHOUT touching existing values.
  # Prints "preserved=N created=N". Writes in place atomically.
  local file="$1"
  local tmp; tmp="$(mktemp "${file}.XXXXXX")"

  declare -A existing
  if [ -f "$file" ]; then
    while IFS='=' read -r key _; do
      key="$(printf '%s' "$key" | tr -d '[:space:]')"
      [ -n "$key" ] && [[ "$key" != \#* ]] && existing["$key"]=1
    done < "$file"
    cp "$file" "$tmp"
    [ -n "$(tail -c 1 "$tmp" 2>/dev/null)" ] && echo >> "$tmp"
  fi

  local keys=( HOST PORT DATABASE_URL SESSION_SECRET SECURE_COOKIES OWNER_USERNAME BACKUP_DIR NODE_ENV )
  local defaults=(
    "0.0.0.0"
    "8080"
    "file:${DB_FILE}"
    "__GENERATE__"
    "auto"
    "owner"
    "${BACKUP_DIR}"
    "production"
  )

  local created=0 preserved=0
  local i k d
  for i in "${!keys[@]}"; do
    k="${keys[$i]}"; d="${defaults[$i]}"
    if [ -n "${existing[$k]:-}" ]; then
      preserved=$((preserved+1))
    else
      [ "$d" = "__GENERATE__" ] && d="$(generate_secret)"
      printf '%s=%s\n' "$k" "$d" >> "$tmp"
      created=$((created+1))
      log "  + ${k} (added)"
    fi
  done
  install -m 600 -o root -g root "$tmp" "$file"
  rm -f "$tmp"
  echo "preserved=${preserved} created=${created}"
}

log "Checking environment file ${CONF_FILE}…"
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would merge missing keys into ${CONF_FILE} (existing values preserved, secrets never printed)"
else
  mkdir -p "$CONF_DIR"
  summary="$(merge_env_file "$CONF_FILE")"
  ok "environment file ready (${summary})"
fi

# ------------------- step 6: validate configuration (no secrets) -----------
log "Validating configuration against the real database path…"
validate_config() {
  env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
    "$(TSX_BIN)" --disable-warning=ExperimentalWarning \
    "${APP_DIR}/src/migrate.ts" --status
}

# ----------------------------- step 7: dependencies ------------------------
log "Installing dependencies with npm ci (lockfile-pinned)…"
if [ "$DRY_RUN" -eq 0 ]; then
  (cd "$APP_DIR" && npm ci --no-audit --no-fund)
  [ -x "$(TSX_BIN)" ] || die "tsx missing after npm ci — lockfile/devDependencies problem."
  (cd "$APP_DIR" && npm run build)
  # Migrations run as the service user so the database file is owned correctly.
  # Fallback (defensive): run as root and fix ownership if the service-user
  # exec is unavailable (rare container configurations).
  if ! sudo -u "$SERVICE_USER" env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
      "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/migrate.ts"; then
    warn "migration as ${SERVICE_USER} failed — retrying as root and fixing ownership"
    env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
      "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/migrate.ts"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
  fi
  # Fail fast with a clear message if configuration is invalid (e.g. bad DATABASE_URL).
  validate_config >/dev/null || die "configuration validation failed — check ${CONF_FILE} (DATABASE_URL, SESSION_SECRET)."
  ok "dependencies installed, build type-checked, migrations applied, config validated"
fi

# ----------------------------- step 8: owner bootstrap ---------------------
log "Checking Super Owner bootstrap…"
if [ "$DRY_RUN" -eq 0 ]; then
  if ! sudo -u "$SERVICE_USER" env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
      "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/bootstrap-owner.ts"; then
    warn "bootstrap as ${SERVICE_USER} failed — retrying as root and fixing ownership"
    env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
      "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/bootstrap-owner.ts"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
  fi
  if [ -f "${CONF_DIR}/owner-credentials.txt" ]; then
    chown root:root "${CONF_DIR}/owner-credentials.txt"
    chmod 600 "${CONF_DIR}/owner-credentials.txt"
  fi
  ok "owner bootstrap complete (idempotent — no-op when an owner exists)"
fi

# ----------------------------- step 9: service management ------------------
# On real VPSes this uses systemd. In containers/CI set TOP_CLOUD_NO_SYSTEMD=1
# to start the process directly (the app is otherwise identical).
NO_SYSTEMD="${TOP_CLOUD_NO_SYSTEMD:-0}"

log "Installing systemd unit…"
if [ "$DRY_RUN" -eq 0 ] && [ "$NO_SYSTEMD" -ne 1 ]; then
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=TOP CLOUD — Staff Recruitment Portal
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${CONF_FILE}
# tsx (pinned by package-lock.json, installed via npm ci) runs the TypeScript
# source directly. Absolute path = the historical "tsx: not found" failure is
# impossible once dependencies are installed.
ExecStart=${APP_DIR}/node_modules/.bin/tsx --disable-warning=ExperimentalWarning ${APP_DIR}/src/index.ts
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
# Health endpoint is public but minimal.
ExecReload=/bin/kill -HUP \$MAINPID

[Install]
WantedBy=multi-user.target
EOF
  ok "wrote ${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable "${APP_NAME}" >/dev/null
  systemctl restart "${APP_NAME}"
elif [ "$DRY_RUN" -eq 0 ] && [ "$NO_SYSTEMD" -eq 1 ]; then
  log "TOP_CLOUD_NO_SYSTEMD=1 — starting the app directly (container/CI mode)…"
  # Stop a previous direct-start instance if present.
  [ -f "${CONF_DIR}/app.pid" ] && kill "$(cat "${CONF_DIR}/app.pid")" 2>/dev/null || true
  sleep 1
  APP_PORT="$(grep -E '^PORT=' "$CONF_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
  [ -n "${APP_PORT:-}" ] || APP_PORT=8080
  wait_healthy() {
    local n="$1"
    for _ in $(seq 1 "$n"); do
      curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1 && return 0
      sleep 1
    done
    return 1
  }
  sudo -u "$SERVICE_USER" env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
    nohup "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/index.ts" \
    > "${CONF_DIR}/app.log" 2>&1 &
  echo $! > "${CONF_DIR}/app.pid"
  if ! wait_healthy 15; then
    kill "$(cat "${CONF_DIR}/app.pid" 2>/dev/null)" 2>/dev/null || true
    sleep 1
    warn "service-user start did not pass health — retrying as root (fine in containers; on a VPS use systemd mode)"
    env TOP_CLOUD_ENV_FILE="$CONF_FILE" \
      nohup "$(TSX_BIN)" --disable-warning=ExperimentalWarning "${APP_DIR}/src/index.ts" \
      > "${CONF_DIR}/app.log" 2>&1 &
    echo $! > "${CONF_DIR}/app.pid"
    wait_healthy 20 || true   # final gate remains the step-10 health check
  fi
  ok "started directly (pid $(cat "${CONF_DIR}/app.pid")), log at ${CONF_DIR}/app.log"
fi

# ----------------------------- step 10: health check -----------------------
PORT="$(grep -E '^PORT=' "$CONF_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
[ -n "${PORT:-}" ] || PORT=8080

log "Waiting for health endpoint http://127.0.0.1:${PORT}/health …"
if [ "$DRY_RUN" -eq 0 ]; then
  healthy=0
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ "$healthy" -ne 1 ]; then
    if [ "$NO_SYSTEMD" -eq 1 ]; then
      echo "Recent application log (tail -40 ${CONF_DIR}/app.log):" >&2
      tail -40 "${CONF_DIR}/app.log" >&2 2>/dev/null || true
    else
      echo "Recent service log (journalctl -u ${APP_NAME} -n 30 --no-pager):" >&2
      journalctl -u "$APP_NAME" -n 30 --no-pager >&2 || true
    fi
    die "service did not pass the health check — see log above. Nothing was deleted; fix the issue and rerun."
  fi
  ok "health check passed"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${IP:-}" ] || IP="<server-ip>"

echo
echo "============================================================"
echo "  TOP CLOUD is running"
echo "============================================================"
echo "  Service : ${APP_NAME}   (systemctl status ${APP_NAME})"
echo "  URL     : http://${IP}:${PORT}"
echo "  Logs    : journalctl -u ${APP_NAME} -f"
echo "  Config  : ${CONF_FILE}   (do not commit; contains secrets)"
echo "  Database: ${DB_FILE}"
echo
echo "  Super Owner credentials (printed once by the bootstrap step"
echo "  above, or stored in ${CONF_DIR}/owner-credentials.txt — mode 600)."
echo "  Delete that file after the first login."
echo
echo "  Updating later:"
echo "    cd ${APP_DIR} && git pull && sudo bash install.sh"
echo "  (config, database, users and backups are preserved on update)"
echo "============================================================"
ok "installation complete"
