#!/usr/bin/env bash
# Set up and run the claims project on a fresh machine (macOS or Debian/Ubuntu Linux).
#
#   ./claims.sh doctor            what is installed and what is missing
#   ./claims.sh prereqs           install missing tools (asks first): Node 22, the .NET 10 SDK (JDK 21 + Maven only with BACKEND=java), Docker hint
#   ./claims.sh setup             install web dependencies and build; build the backend if its toolchain is present
#   ./claims.sh web [--preview]   run the mock at http://localhost:5173 (--preview serves the built dist/ on :4173)
#   ./claims.sh infra up|down     Postgres and a dev Temporal server in Docker (set PG_PORT if 5432 is taken)
#   ./claims.sh backend           run the API on http://localhost:8080 (needs `infra up` first)
#   ./claims.sh test              web typecheck and lint; backend tests (against Postgres when reachable; CLAIMS_SKIP_WEB=1 skips the web part)
#   ./claims.sh pack              tar.gz of the project without node_modules, dist, target, bin and obj, to copy elsewhere
#   ./claims.sh demo up|down|status   the whole demo, live: Postgres, the .NET API with an embedded Temporal dev server and a virtual clock, and the web app
#                                 (web http://localhost:5173, API :8080, Temporal UI :8233). Needs the .NET 10 SDK and Node, and a local Postgres
#                                 (127.0.0.1:5432; database claims_demo is created/reset) or Docker. Env: DEMO_PG_HOST/PORT/USER/PASSWORD,
#                                 DEMO_API_PORT, DEMO_WEB_PORT, DEMO_TEMPORAL_PORT, DEMO_TEMPORAL_UI_PORT. `demo down` stops only what `demo up` started.
#                                 The daily payment run and the bank-returns poller are OFF by default so the presenter decides when the batch runs
#                                 (POST /payment-runs, POST /payment-runs/returns:process, the web buttons); DEMO_DAILY_RUN=true turns both on.
#
# The web mock needs only Node. The backend is optional. There are two implementations of the same slice, chosen with BACKEND:
#   BACKEND=dotnet (default)   backend-dotnet/: .NET 10 SDK, ASP.NET Core, Dapper, DbUp, Temporalio
#   BACKEND=java               backend/: JDK 21 and Maven, Spring Boot
# Either one needs Docker (or your own Postgres and Temporal) to run against.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$ROOT/web"
BACKEND="${BACKEND:-dotnet}"
case "$BACKEND" in
  dotnet) BACK="$ROOT/backend-dotnet" ;;
  java)   BACK="$ROOT/backend" ;;
  *) printf 'BACKEND must be dotnet or java (got "%s")\n' "$BACKEND" >&2; exit 1 ;;
esac
COMPOSE_FILE="$BACK/docker/docker-compose.yml"
PG_PORT="${PG_PORT:-5432}"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="other"
case "$(uname -s)" in
  Darwin) OS="mac" ;;
  Linux)  have apt-get && OS="debian" ;;
esac

# ---------------------------------------------------------------- tool checks

# Vite 8 needs Node ^20.19 or >=22.12.
node_ok() {
  have node || return 1
  local v major minor
  v="$(node -v | sed 's/^v//')"; major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt 22 ] && return 0
  [ "$major" -eq 22 ] && [ "$minor" -ge 12 ] && return 0
  [ "$major" -eq 20 ] && [ "$minor" -ge 19 ] && return 0
  return 1
}

# Finds a JDK 21 and exports JAVA_HOME for this run only. Leaves the system Java alone.
find_java21() {
  local c
  for c in "${JAVA_HOME:-}" \
           "$( [ "$OS" = mac ] && /usr/libexec/java_home -v 21 2>/dev/null || true )" \
           "$( have brew && echo "$(brew --prefix openjdk@21 2>/dev/null)/libexec/openjdk.jdk/Contents/Home" || true )" \
           /usr/lib/jvm/java-21-openjdk-amd64 /usr/lib/jvm/java-21-openjdk-arm64 /usr/lib/jvm/temurin-21-jdk-amd64; do
    [ -n "$c" ] && [ -x "$c/bin/java" ] || continue
    if "$c/bin/java" -version 2>&1 | grep -q 'version "21'; then export JAVA_HOME="$c"; export PATH="$JAVA_HOME/bin:$PATH"; return 0; fi
  done
  if have java && java -version 2>&1 | grep -q 'version "21'; then return 0; fi
  return 1
}

# True when a .NET SDK of major version 10 or newer is usable. Looks at DOTNET_ROOT and ~/.dotnet (the dotnet-install.sh
# locations) before PATH, and exports DOTNET_ROOT/PATH for this run only when it finds one there.
dotnet_ok() {
  local c v
  for c in "${DOTNET_ROOT:-}" "$HOME/.dotnet"; do
    [ -n "$c" ] && [ -x "$c/dotnet" ] || continue
    v="$("$c/dotnet" --version 2>/dev/null || true)"
    if [ -n "$v" ] && [ "${v%%.*}" -ge 10 ] 2>/dev/null; then export DOTNET_ROOT="$c"; export PATH="$c:$PATH"; return 0; fi
  done
  have dotnet || return 1
  v="$(dotnet --version 2>/dev/null || true)"
  [ -n "$v" ] && [ "${v%%.*}" -ge 10 ] 2>/dev/null
}

docker_ok() { have docker && docker info >/dev/null 2>&1; }

# The backend's own toolchain is present (see BACKEND).
backend_toolchain_ok() {
  if [ "$BACKEND" = dotnet ]; then dotnet_ok; else find_java21 && have mvn; fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose -f "$COMPOSE_FILE" "$@"
  elif have docker-compose; then docker-compose -f "$COMPOSE_FILE" "$@"
  else die "Docker Compose not found. Install Docker Desktop (or the docker-compose-plugin package)."; fi
}

# ---------------------------------------------------------------- commands

cmd_doctor() {
  say "Web mock"
  if node_ok; then ok "Node $(node -v), npm $(npm -v)"; else miss "Node 20.19+ or 22.12+ ($(have node && node -v || echo 'not installed'))"; fi
  say "Backend (optional): BACKEND=$BACKEND"
  if [ "$BACKEND" = dotnet ]; then
    if dotnet_ok; then ok ".NET SDK $(dotnet --version)"; else miss ".NET SDK 10 or newer ($(have dotnet && dotnet --version || echo 'not installed'))"; fi
  else
    if find_java21; then ok "JDK 21 ($JAVA_HOME)"; else miss "JDK 21 ($(have java && java -version 2>&1 | head -1 || echo 'not installed'))"; fi
    if have mvn; then ok "Maven $(mvn -v 2>/dev/null | head -1 | awk '{print $3}')"; else miss "Maven"; fi
    if dotnet_ok; then ok ".NET SDK $(dotnet --version) (only needed with BACKEND=dotnet)"; else warn ".NET SDK not found (only needed with BACKEND=dotnet)"; fi
  fi
  # The demo needs a Postgres: a local server it can log in to, or Docker. Temporal needs nothing extra: the API embeds a dev server.
  say "Postgres for ./claims.sh demo up"
  if have psql && { have pg_isready && pg_isready -h "$DEMO_PG_HOST" -p "$DEMO_PG_PORT" >/dev/null 2>&1; }; then ok "A Postgres answers on $DEMO_PG_HOST:$DEMO_PG_PORT and psql is installed (set DEMO_PG_USER / DEMO_PG_PASSWORD if it needs a login)"
  elif docker_ok; then ok "Docker is running, so the demo can start its own Postgres"
  elif have docker; then warn "Docker is installed but the daemon is not running: start Docker Desktop, or point the demo at a Postgres you already run"
  else warn "No Postgres found: run one on $DEMO_PG_HOST:$DEMO_PG_PORT (and install psql), or install and start Docker"; fi
  echo
  if node_ok; then echo "The web mock can run now:  ./claims.sh setup && ./claims.sh web"; else echo "Run ./claims.sh prereqs to install what is missing."; fi
}

cmd_prereqs() {
  say "Installing prerequisites ($OS)"
  local plan=()
  case "$OS" in
    mac)
      have brew || die "Homebrew is required on macOS: https://brew.sh"
      node_ok || plan+=("brew install node@22 && brew link --overwrite --force node@22")
      if [ "$BACKEND" = dotnet ]; then
        dotnet_ok || plan+=("brew install dotnet-sdk")
      else
        find_java21 || plan+=("brew install openjdk@21")
        have mvn || plan+=("brew install maven")
      fi
      have temporal || plan+=("brew install temporal")
      docker_ok || have docker || warn "Docker is not installed: install Docker Desktop from https://www.docker.com/products/docker-desktop (or skip it and use 'temporal' plus your own Postgres)"
      ;;
    debian)
      node_ok || plan+=("curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs")
      if [ "$BACKEND" = dotnet ]; then
        dotnet_ok || plan+=("sudo apt-get update && sudo apt-get install -y dotnet-sdk-10.0")
        dotnet_ok || warn "If apt cannot find dotnet-sdk-10.0, add Microsoft's package feed first: https://learn.microsoft.com/dotnet/core/install/linux"
      else
        find_java21 || plan+=("sudo apt-get update && sudo apt-get install -y openjdk-21-jdk")
        have mvn || plan+=("sudo apt-get install -y maven")
      fi
      docker_ok || have docker || warn "Docker is not installed: see https://docs.docker.com/engine/install/ (then add your user to the docker group)"
      ;;
    *) die "Unsupported OS for automatic install. Install Node 22, the .NET 10 SDK (or JDK 21 and Maven for BACKEND=java) and Docker yourself, then run ./claims.sh setup." ;;
  esac
  if [ "${#plan[@]}" -eq 0 ]; then ok "Nothing to install."; return; fi
  echo "These commands will run:"; printf '  %s\n' "${plan[@]}"
  if [ "${CLAIMS_YES:-}" != 1 ]; then
    read -r -p "Continue? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || die "Cancelled."
  fi
  local c; for c in "${plan[@]}"; do bash -c "$c"; done
  say "Done. Open a new shell if 'node', 'dotnet' or 'java' is not found, then run ./claims.sh doctor"
}

cmd_setup() {
  node_ok || die "Node 20.19+ or 22.12+ is required. Run ./claims.sh prereqs"
  say "Web: installing dependencies"
  (cd "$WEB" && npm ci --no-audit --no-fund)
  say "Web: build"
  (cd "$WEB" && npm run build)
  ok "Web is ready: ./claims.sh web"
  if backend_toolchain_ok; then
    say "Backend ($BACKEND): build (tests skipped; run ./claims.sh test)"
    if [ "$BACKEND" = dotnet ]; then (cd "$BACK" && dotnet build src/Claims.Api -c Release -v q)
    else (cd "$BACK" && mvn -q -DskipTests package); fi
    ok "Backend is built: ./claims.sh infra up && ./claims.sh backend"
  else
    warn "Skipping the backend ($BACKEND): its toolchain is missing (./claims.sh doctor). The web mock does not need it."
  fi
}

cmd_web() {
  [ -d "$WEB/node_modules" ] || die "Run ./claims.sh setup first."
  cd "$WEB"
  if [ "${1:-}" = "--preview" ]; then exec npx vite preview --host --port 4173
  else exec npx vite --host --port 5173; fi
}

cmd_infra() {
  docker_ok || die "Docker is not running. Start Docker Desktop, or run your own Postgres and Temporal (see backend/README.md)."
  case "${1:-}" in
    up)
      PG_PORT="$PG_PORT" compose up -d
      say "Waiting for Postgres on $PG_PORT"
      local i; for i in $(seq 1 30); do
        compose exec -T postgres pg_isready -U claims -d claims >/dev/null 2>&1 && break
        sleep 2
      done
      compose exec -T postgres pg_isready -U claims -d claims >/dev/null 2>&1 || die "Postgres did not become ready. See: docker compose -f backend/docker/docker-compose.yml logs postgres"
      ok "Postgres on localhost:$PG_PORT (db claims, user claims, password claims)"
      ok "Temporal dev server on localhost:7233, UI http://localhost:8233"
      ;;
    down) compose down; ok "Stopped. Data is kept in the claims-pgdata volume; 'docker compose down -v' would delete it." ;;
    *) die "Usage: ./claims.sh infra up|down" ;;
  esac
}

cmd_backend() {
  # CLAIMS_DB_URL is a JDBC-style URL for both backends (the .NET one also accepts an Npgsql connection string).
  export CLAIMS_DB_URL="${CLAIMS_DB_URL:-jdbc:postgresql://localhost:$PG_PORT/claims}"
  if [ "$BACKEND" = dotnet ]; then
    dotnet_ok || die ".NET SDK 10 or newer is required. Run ./claims.sh prereqs"
    export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
    export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://localhost:8080}"
    say "API on $ASPNETCORE_URLS (.NET, environment $ASPNETCORE_ENVIRONMENT, db $CLAIMS_DB_URL)"
    cd "$BACK/src/Claims.Api" && exec dotnet run --no-launch-profile
  fi
  find_java21 || die "JDK 21 is required. Run ./claims.sh prereqs"
  have mvn || die "Maven is required. Run ./claims.sh prereqs"
  export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-dev}"
  say "API on http://localhost:8080 (Java, profile $SPRING_PROFILES_ACTIVE, db $CLAIMS_DB_URL)"
  cd "$BACK" && exec mvn -q spring-boot:run
}

cmd_test() {
  if [ "${CLAIMS_SKIP_WEB:-}" = 1 ]; then
    warn "Skipping the web checks (CLAIMS_SKIP_WEB=1)"
  else
    node_ok || die "Node 20.19+ or 22.12+ is required."
    say "Web: typecheck and lint"
    (cd "$WEB" && npx tsc -b && npx oxlint)
  fi
  if backend_toolchain_ok; then
    say "Backend ($BACKEND): tests"
    if [ -z "${TEST_PG_URL:-}" ] && have pg_isready && pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
      export TEST_PG_URL="jdbc:postgresql://127.0.0.1:$PG_PORT/postgres"
      export TEST_PG_USER="${TEST_PG_USER:-claims}" TEST_PG_PASSWORD="${TEST_PG_PASSWORD:-claims}"
      warn "Using the Postgres on port $PG_PORT (each test class creates its own database there)"
    fi
    [ -n "${TEST_PG_URL:-}" ] || warn "No TEST_PG_URL and no Postgres reachable: the Postgres tests will be skipped"
    if [ "$BACKEND" = dotnet ]; then (cd "$BACK" && dotnet test Claims.sln)
    else (cd "$BACK" && mvn -q verify); fi
  else
    warn "Skipping backend tests ($BACKEND toolchain not found: ./claims.sh doctor)"
  fi
}

cmd_pack() {
  local out="$ROOT/claims-$(date +%Y%m%d).tar.gz"
  tar -C "$ROOT/.." -czf "$out" \
    --exclude='node_modules' --exclude='dist' --exclude='target' --exclude='bin' --exclude='obj' --exclude='TestResults' --exclude='.DS_Store' --exclude='*.tar.gz' \
    "$(basename "$ROOT")"
  ok "$out"
  echo "On the other machine:  tar xzf $(basename "$out") && cd $(basename "$ROOT") && ./claims.sh prereqs && ./claims.sh setup && ./claims.sh web"
}

# ---------------------------------------------------------------- demo: one command for the live end-to-end demo
#
#   ./claims.sh demo up      Postgres (a local server if reachable, else Docker), the API in Development with the demo switches, the web dev server
#   ./claims.sh demo status  what is running and where
#   ./claims.sh demo down    stops what `demo up` started (pid files in .demo/), nothing else; the claims_demo database is kept until the next `demo up`
#
# What `demo up` switches on in the API: Claims:Dev:Controls (the /dev/clock endpoints, the virtual clock), Claims:Temporal:DevServer (a real Temporal dev server
# inside the API process; the first run downloads the Temporal CLI), the dispatcher's Temporal Schedule every 5 s (always on), and the nightly overdue check every 5 s of real
# time (once per virtual day from 02:30; DEMO_OVERDUE_CHECK=false turns it off). The daily payment run's in-process trigger (which also runs the bank-returns batch once per
# virtual day from 06:30) is OFF by default: with it on, the run can pay within seconds of the virtual clock reaching the pay date, before a presenter clicks "Run payment run
# now". The presenter starts the batch by hand (POST /payment-runs, POST /payment-runs/returns:process, or the web buttons); DEMO_DAILY_RUN=true switches the trigger on (every 3 s). Faults for the "things bounce back" scenario are toggled at run time (POST /dev/faults), so they need no setting here.
# The web dev server gets VITE_API_BASE=/api and DEMO_API_TARGET=http://127.0.0.1:<api port> (a Vite proxy forwards /api to the API, so there is no CORS).

DEMO_DIR="$ROOT/.demo"
DEMO_DB="claims_demo"
DEMO_API_PORT="${DEMO_API_PORT:-8080}"
DEMO_WEB_PORT="${DEMO_WEB_PORT:-5173}"
DEMO_TEMPORAL_PORT="${DEMO_TEMPORAL_PORT:-7233}"
DEMO_TEMPORAL_UI_PORT="${DEMO_TEMPORAL_UI_PORT:-8233}"
DEMO_PG_HOST="${DEMO_PG_HOST:-127.0.0.1}"
DEMO_PG_PORT="${DEMO_PG_PORT:-$PG_PORT}"
DEMO_WAIT="${DEMO_WAIT:-240}"

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# True when something already listens on the port (ours or not: `demo up` refuses to start on top of it).
port_busy() {
  if have lsof; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

http_ok() { curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null; }

demo_state_get() { [ -f "$DEMO_DIR/state" ] && sed -n "s/^$1=//p" "$DEMO_DIR/state" | tail -1 || true; }

demo_state_set() { grep -v "^$1=" "$DEMO_DIR/state" > "$DEMO_DIR/state.tmp" 2>/dev/null || true; echo "$1=$2" >> "$DEMO_DIR/state.tmp"; mv "$DEMO_DIR/state.tmp" "$DEMO_DIR/state"; }

# Postgres, first choice: a server that already answers on DEMO_PG_HOST:DEMO_PG_PORT. Only the database claims_demo is ever created or dropped.
demo_pg_local() {
  have psql || return 1
  if have pg_isready; then pg_isready -h "$DEMO_PG_HOST" -p "$DEMO_PG_PORT" >/dev/null 2>&1 || return 1
  else (exec 3<>"/dev/tcp/$DEMO_PG_HOST/$DEMO_PG_PORT") >/dev/null 2>&1 || return 1; fi
  local u users
  DEMO_PG_STATE=answers
  if [ -n "${DEMO_PG_USER:-}" ]; then users="$DEMO_PG_USER"; else users="postgres $(id -un)"; fi
  for u in $users; do
    if PGPASSWORD="${DEMO_PG_PASSWORD:-}" psql -w -h "$DEMO_PG_HOST" -p "$DEMO_PG_PORT" -U "$u" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      DEMO_PG_LOGIN="$u"; return 0
    fi
  done
  DEMO_PG_LOGIN=""
  DEMO_PG_STATE=badlogin
  return 1
}

demo_pg_reset_local() {
  local psqlx=(psql -w -q -h "$DEMO_PG_HOST" -p "$DEMO_PG_PORT" -U "$DEMO_PG_LOGIN" -d postgres -v ON_ERROR_STOP=1)
  PGPASSWORD="${DEMO_PG_PASSWORD:-}" "${psqlx[@]}" -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE)" -c "CREATE DATABASE $DEMO_DB" \
    || die "Could not (re)create the database $DEMO_DB on $DEMO_PG_HOST:$DEMO_PG_PORT as $DEMO_PG_LOGIN"
}

demo_pg_docker() {
  docker_ok || return 1
  say "Postgres: starting the docker compose service (port $DEMO_PG_PORT)"
  PG_PORT="$DEMO_PG_PORT" compose up -d postgres >/dev/null
  local i; for i in $(seq 1 30); do compose exec -T postgres pg_isready -U claims -d claims >/dev/null 2>&1 && break; sleep 2; done
  compose exec -T postgres pg_isready -U claims -d claims >/dev/null 2>&1 || die "The Postgres container did not become ready (docker compose -f $COMPOSE_FILE logs postgres)"
  compose exec -T postgres psql -q -U claims -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE)" -c "CREATE DATABASE $DEMO_DB" \
    || die "Could not (re)create the database $DEMO_DB in the container"
  return 0
}

demo_up() {
  [ -f "$DEMO_DIR/state" ] && { pid_alive "$DEMO_DIR/api.pid" || pid_alive "$DEMO_DIR/web.pid"; } && die "The demo is already running (./claims.sh demo status). Run ./claims.sh demo down first."
  node_ok || die "Node 20.19+ or 22.12+ is required for the web app (./claims.sh prereqs)."
  dotnet_ok || die ".NET SDK 10 or newer is required for the API (./claims.sh prereqs). Nothing was started."
  have curl || die "curl is required."
  [ "$BACKEND" = dotnet ] || die "demo needs the .NET backend (BACKEND=dotnet); the Java copy has no virtual clock or decisions."
  local p
  for p in "$DEMO_API_PORT" "$DEMO_WEB_PORT" "$DEMO_TEMPORAL_PORT" "$DEMO_TEMPORAL_UI_PORT"; do
    if port_busy "$p"; then die "Port $p is already in use by something this script did not start. Free it, or set DEMO_API_PORT / DEMO_WEB_PORT / DEMO_TEMPORAL_PORT / DEMO_TEMPORAL_UI_PORT."; fi
  done
  mkdir -p "$DEMO_DIR"; printf '*\n' > "$DEMO_DIR/.gitignore"; : > "$DEMO_DIR/state"

  # ---- Postgres
  local pg_mode="" pg_user pg_password pg_host="$DEMO_PG_HOST" pg_port="$DEMO_PG_PORT"
  DEMO_PG_LOGIN=""; DEMO_PG_STATE=""
  if demo_pg_local; then
    say "Postgres: using the local server on $DEMO_PG_HOST:$DEMO_PG_PORT as $DEMO_PG_LOGIN; (re)creating the database $DEMO_DB (no other database is touched)"
    demo_pg_reset_local
    pg_mode=local; pg_user="$DEMO_PG_LOGIN"; pg_password="${DEMO_PG_PASSWORD:-}"
  elif [ "$DEMO_PG_STATE" != badlogin ] && demo_pg_docker; then   # a server that answers but refuses us is not replaced by a container fighting for its port
    pg_mode=docker; pg_user=claims; pg_password=claims
  else
    local why=""
    have psql || why="$why
  - psql is not installed, so a local Postgres cannot be used (install the PostgreSQL client tools)"
    if have psql; then
      if have pg_isready && pg_isready -h "$DEMO_PG_HOST" -p "$DEMO_PG_PORT" >/dev/null 2>&1; then
        why="$why
  - a Postgres answers on $DEMO_PG_HOST:$DEMO_PG_PORT but no login worked (tried ${DEMO_PG_USER:-postgres and $(id -un)}): set DEMO_PG_USER and DEMO_PG_PASSWORD"
      else
        why="$why
  - no Postgres answers on $DEMO_PG_HOST:$DEMO_PG_PORT: start one, or point DEMO_PG_HOST / DEMO_PG_PORT at yours"
      fi
    fi
    [ "$DEMO_PG_STATE" = badlogin ] || docker_ok || why="$why
  - Docker is not running ($(have docker && echo 'the daemon is off: start Docker Desktop' || echo 'not installed')), so the compose Postgres cannot be used"
    rm -f "$DEMO_DIR/state"
    die "The demo needs a Postgres and none is available:$why"
  fi
  demo_state_set PG_MODE "$pg_mode"; demo_state_set PG_HOST "$pg_host"; demo_state_set PG_PORT "$pg_port"; demo_state_set PG_USER "$pg_user"
  ok "Postgres ($pg_mode): database $DEMO_DB on $pg_host:$pg_port"

  # ---- API: Development, the demo switches, an embedded Temporal dev server, everything on real time except the virtual clock
  say "API: building"
  (cd "$BACK" && dotnet build src/Claims.Api -c Release -v q --nologo >"$DEMO_DIR/build.log" 2>&1) || { tail -20 "$DEMO_DIR/build.log" >&2; die "The API did not build (see $DEMO_DIR/build.log)"; }
  local api_url="http://127.0.0.1:$DEMO_API_PORT"
  say "API: starting on $api_url (the first start downloads the Temporal CLI for the embedded dev server; log $DEMO_DIR/api.log)"
  (
    cd "$BACK/src/Claims.Api"
    export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$api_url"
    export CLAIMS_DB_URL="Host=$pg_host;Port=$pg_port;Database=$DEMO_DB" CLAIMS_DB_USER="$pg_user" CLAIMS_DB_PASSWORD="$pg_password"
    export Claims__Dev__Controls=true
    export Claims__Temporal__DevServer=true Claims__Temporal__DevServerPort="$DEMO_TEMPORAL_PORT" Claims__Temporal__DevServerUiPort="$DEMO_TEMPORAL_UI_PORT"
    export Claims__Dispatcher__ScheduleEnabled=true Claims__Dispatcher__ScheduleInterval=00:00:05 Claims__Dispatcher__LocalPollEnabled=false
    # The daily payment run and the returns poller share one switch (Claims:PaymentRun:ScheduleEnabled; Development would turn it on, so it is set explicitly here).
    # Off by default: the presenter runs the batch by hand. DEMO_DAILY_RUN=true turns both on (polling every 3 s).
    export Claims__PaymentRun__ScheduleEnabled="${DEMO_DAILY_RUN:-false}" Claims__PaymentRun__PollInterval=00:00:03
    # The nightly overdue check runs from the same kind of in-process timer (DEMO_OVERDUE_CHECK=false turns it off).
    export Claims__OverdueCheck__ScheduleEnabled="${DEMO_OVERDUE_CHECK:-true}" Claims__OverdueCheck__PollInterval=00:00:05
    nohup dotnet bin/Release/net10.0/Claims.Api.dll >"$DEMO_DIR/api.log" 2>&1 &
    echo $! > "$DEMO_DIR/api.pid"
  )
  local waited=0
  until http_ok "$api_url/actuator/health" && http_ok "$api_url/claims"; do
    pid_alive "$DEMO_DIR/api.pid" || { tail -25 "$DEMO_DIR/api.log" >&2; demo_down_quiet; die "The API stopped while starting (log above; full log $DEMO_DIR/api.log)"; }
    waited=$((waited + 2)); [ "$waited" -le "$DEMO_WAIT" ] || { tail -25 "$DEMO_DIR/api.log" >&2; demo_down_quiet; die "The API did not answer within ${DEMO_WAIT}s"; }
    sleep 2
  done
  ok "API is up on $api_url (waited ${waited}s)"

  # ---- web
  [ -d "$WEB/node_modules" ] || { say "Web: installing dependencies"; (cd "$WEB" && npm ci --no-audit --no-fund >"$DEMO_DIR/npm.log" 2>&1) || die "npm ci failed (see $DEMO_DIR/npm.log)"; }
  say "Web: starting the dev server on port $DEMO_WEB_PORT"
  (
    cd "$WEB"
    export VITE_API_BASE=/api DEMO_API_TARGET="$api_url"
    nohup ./node_modules/.bin/vite --host 127.0.0.1 --port "$DEMO_WEB_PORT" --strictPort >"$DEMO_DIR/web.log" 2>&1 &
    echo $! > "$DEMO_DIR/web.pid"
  )
  waited=0
  until http_ok "http://127.0.0.1:$DEMO_WEB_PORT/"; do
    pid_alive "$DEMO_DIR/web.pid" || { tail -15 "$DEMO_DIR/web.log" >&2; demo_down_quiet; die "The web dev server stopped while starting (log above)"; }
    waited=$((waited + 1)); [ "$waited" -le 60 ] || { tail -15 "$DEMO_DIR/web.log" >&2; demo_down_quiet; die "The web dev server did not answer within 60s"; }
    sleep 1
  done
  demo_state_set API_PORT "$DEMO_API_PORT"; demo_state_set WEB_PORT "$DEMO_WEB_PORT"; demo_state_set TEMPORAL_UI_PORT "$DEMO_TEMPORAL_UI_PORT"
  echo
  say "The demo is running"
  ok "Web          http://localhost:$DEMO_WEB_PORT      (VITE_API_BASE=/api, DEMO_API_TARGET=$api_url)"
  ok "API          $api_url   (Development; dev controls on: GET $api_url/dev/clock)"
  ok "Temporal UI  http://localhost:$DEMO_TEMPORAL_UI_PORT   (embedded dev server, gRPC on $DEMO_TEMPORAL_PORT, in memory: it starts empty each time)"
  ok "Postgres     $pg_host:$pg_port database $DEMO_DB ($pg_mode)"
  if [ "${DEMO_DAILY_RUN:-false}" = true ]; then ok "Daily payment run and returns poller: ON (DEMO_DAILY_RUN=true), they pay by themselves once the virtual clock passes the pay date"
  else ok "Daily payment run and returns poller: OFF; run the batch by hand: POST $api_url/payment-runs and POST $api_url/payment-runs/returns:process (DEMO_DAILY_RUN=true turns them on)"; fi
  echo "  Staff for X-Actor: rachel (examiner, \$250,000 authority), monica (team lead). Move time: POST $api_url/dev/clock:advance {\"days\":1} | {\"until\":\"next_deadline\"}"
  echo "  Stop with ./claims.sh demo down; look at it with ./claims.sh demo status. Logs are in $DEMO_DIR/."
}

# Stops what `demo up` started, in reverse order: the web server, the API (SIGTERM, so its embedded Temporal shuts down cleanly), the compose Postgres.
demo_stop_pid() {
  local name="$1" f="$DEMO_DIR/$2.pid" pid i
  if [ ! -f "$f" ]; then return 0; fi
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then
      pkill -P "$pid" 2>/dev/null || true; kill -9 "$pid" 2>/dev/null || true
      warn "$name (pid $pid) did not stop in 10 s and was killed"
    else ok "$name stopped (pid $pid)"; fi
  else
    warn "$name (pid $pid) was not running"
  fi
  rm -f "$f"
}

demo_down_quiet() {
  demo_stop_pid web web >/dev/null 2>&1 || true
  demo_stop_pid API api >/dev/null 2>&1 || true
  if [ "$(demo_state_get PG_MODE)" = docker ]; then compose down >/dev/null 2>&1 || true; fi
  rm -f "$DEMO_DIR/state"
}

demo_down() {
  if [ ! -d "$DEMO_DIR" ] || { [ ! -f "$DEMO_DIR/web.pid" ] && [ ! -f "$DEMO_DIR/api.pid" ] && [ ! -f "$DEMO_DIR/state" ]; }; then
    ok "Nothing to stop: the demo is not running (no .demo/ pid files)."; return 0
  fi
  local mode; mode="$(demo_state_get PG_MODE)"
  demo_stop_pid "Web dev server" web
  demo_stop_pid "API (and its embedded Temporal)" api
  if [ "$mode" = docker ]; then compose down >/dev/null 2>&1 && ok "Postgres container stopped (data kept in the claims-pgdata volume)"; fi
  if [ "$mode" = local ]; then ok "Local Postgres left running; the database $DEMO_DB is kept until the next 'demo up' resets it"; fi
  rm -f "$DEMO_DIR/state"
}

demo_status() {
  local api_port web_port ui_port mode host port user
  api_port="$(demo_state_get API_PORT)"; web_port="$(demo_state_get WEB_PORT)"; ui_port="$(demo_state_get TEMPORAL_UI_PORT)"
  mode="$(demo_state_get PG_MODE)"; host="$(demo_state_get PG_HOST)"; port="$(demo_state_get PG_PORT)"; user="$(demo_state_get PG_USER)"
  if [ -z "$mode" ] && ! pid_alive "$DEMO_DIR/api.pid" && ! pid_alive "$DEMO_DIR/web.pid"; then
    say "Demo"; miss "not running (./claims.sh demo up)"; return 0
  fi
  say "Demo"
  if [ "$mode" = local ]; then
    if PGPASSWORD="${DEMO_PG_PASSWORD:-}" psql -w -h "$host" -p "$port" -U "$user" -d "$DEMO_DB" -tAc 'select 1' >/dev/null 2>&1; then ok "Postgres (local) $host:$port, database $DEMO_DB reachable"; else miss "Postgres (local) $host:$port, database $DEMO_DB not reachable"; fi
  elif [ "$mode" = docker ]; then
    if docker_ok && compose exec -T postgres pg_isready -U claims -d claims >/dev/null 2>&1; then ok "Postgres (docker compose) on $port"; else miss "Postgres (docker compose) not answering"; fi
  else warn "Postgres: unknown (no state file)"; fi
  if pid_alive "$DEMO_DIR/api.pid"; then
    if http_ok "http://127.0.0.1:$api_port/actuator/health"; then ok "API pid $(cat "$DEMO_DIR/api.pid") up: http://127.0.0.1:$api_port"; else warn "API pid $(cat "$DEMO_DIR/api.pid") is running but /actuator/health does not answer"; fi
    local clock; clock="$(curl -fsS --max-time 3 "http://127.0.0.1:$api_port/dev/clock" 2>/dev/null || true)"
    [ -z "$clock" ] || echo "    clock: $clock"
    if [ -n "$ui_port" ] && http_ok "http://127.0.0.1:$ui_port/"; then ok "Temporal UI (embedded dev server): http://localhost:$ui_port"; else warn "Temporal UI does not answer${ui_port:+ on port $ui_port}"; fi
  else miss "API is not running"; fi
  if pid_alive "$DEMO_DIR/web.pid"; then
    if http_ok "http://127.0.0.1:$web_port/"; then ok "Web pid $(cat "$DEMO_DIR/web.pid") up: http://localhost:$web_port"; else warn "Web pid $(cat "$DEMO_DIR/web.pid") is running but does not answer on $web_port"; fi
  else miss "Web dev server is not running"; fi
  echo "  logs: $DEMO_DIR/api.log  $DEMO_DIR/web.log"
}

cmd_demo() {
  case "${1:-}" in
    up)     demo_up ;;
    down)   demo_down ;;
    status) demo_status ;;
    *) die "Usage: ./claims.sh demo up|down|status" ;;
  esac
}

case "${1:-}" in
  doctor)  cmd_doctor ;;
  prereqs) cmd_prereqs ;;
  setup)   cmd_setup ;;
  web)     shift; cmd_web "$@" ;;
  infra)   shift; cmd_infra "$@" ;;
  backend) cmd_backend ;;
  test)    cmd_test ;;
  pack)    cmd_pack ;;
  demo)    shift; cmd_demo "$@" ;;
  *) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; [ -z "${1:-}" ] || exit 1 ;;
esac
