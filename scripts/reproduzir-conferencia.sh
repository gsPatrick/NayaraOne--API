#!/usr/bin/env bash
# Reprodução LOCAL da suíte do CI (Conferência Marcos 4/5, Nayara 18/10/2026, pedido 2).
#
# Faz exatamente o que o job "test" de .github/workflows/test.yml faz, numa máquina qualquer:
#   1. PostgreSQL 16 DESCARTÁVEL (docker run postgres:16; sem docker, cluster local com initdb
#      num diretório temporário — nunca toca o banco compartilhado);
#   2. migrations do zero + seeds base + seed de dois tenants fictícios com perfis
#      maker/checker/leitura (scripts/seed-ci-two-tenants.js), como superusuário do cluster;
#   3. role de runtime nayara_ci_app NOSUPERUSER NOBYPASSRLS com GRANT por schema;
#   4. a suíte inteira com NODE_ENV=test, reporter spec, gravada em test-results.log com
#      cabeçalho (commit avaliado, modo do Postgres, usuário do banco);
#   5. derruba o banco ao final (container removido / cluster parado e diretório apagado).
#
# COMANDO COMPLETO (do zero, em qualquer máquina com Node 20 e Docker OU PostgreSQL 16 com initdb):
#   git clone https://github.com/gsPatrick/NayaraOne--API.git && cd NayaraOne--API
#   git checkout <HASH-DO-COMMIT>            # o hash declarado na página/log de entrega
#   npm ci
#   bash scripts/reproduzir-conferencia.sh   # gera ./test-results.log
# O script roda, NESTA ORDEM, o mesmo que o job "test" do workflow: lint, syntax-check, scanner de
# hard-code, SAST, security scan (npm audit), migrations, seeds, role de menor privilégio e a
# suíte com o MESMO comando do CI:  node --test --test-reporter=spec test/*.test.js test/marco8/*.test.js
# (sem --test-concurrency=1; para rodar em série use REPRO_SERIAL=1). Node: o CI usa 20; com outra
# major o script avisa no cabeçalho do log (ou aborta com REPRO_REQUIRE_NODE20=1).
# Logs do CI (artifact test-results-<commit>): gh run download <RUN_ID> -R gsPatrick/NayaraOne--API
# Reexecução no próprio GitHub (sem deploy): Actions > CI > Run workflow (workflow_dispatch),
# escolhendo a branch/commit; o job "test" é o mesmo que este script reproduz.
# Este script e o workflow COINCIDEM: o script é que foi ajustado ao workflow (nada foi mudado no
# comando de teste do CI). Diferença única: o CI define CI=true automaticamente (o script também).
# Ao final grava também <saida>.saneado.log (scripts/sanear-log-teste.js): sem log JSON de
# requisição e sem padrões de segredo, com o sha256 do original no cabeçalho.
#
# Uso:  bash scripts/reproduzir-conferencia.sh [arquivo-de-saida.log] [padrão-de-testes]
#       ex.: bash scripts/reproduzir-conferencia.sh /tmp/r.log 'test/nayaraConferencia1810*.test.js'
# REPRO_CAPTURA=1 roda, depois da suíte, scripts/capturar-evidencias-marco45.js (JSON com HTTP real, passos de serviço e consultas SQL).
# Variáveis: REPRO_PG_PORT (padrão 55432), REPRO_FORCE_LOCAL=1 (ignora docker), REPRO_SERIAL=1,
#            REPRO_SKIP_CHECKS=1 (pula lint/syntax/scanners), REPRO_REQUIRE_NODE20=1.
#
# Todos os segredos abaixo são os mesmos "not-for-production" públicos do workflow do CI: só
# existem dentro do banco descartável deste script.
set -euo pipefail

API_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$API_ROOT"
OUT="${1:-$API_ROOT/test-results.log}"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "20" ]; then
  echo "[reproduzir] AVISO: Node $(node -v) — o CI usa Node 20."
  [ -z "${REPRO_REQUIRE_NODE20:-}" ] || exit 2
fi
if [ -z "${REPRO_SKIP_CHECKS:-}" ]; then
  echo "[reproduzir] lint…";           npm run -s lint
  echo "[reproduzir] syntax-check…";   npm run -s syntax-check
  echo "[reproduzir] hard-code…";      node scripts/scanConstructionHardcode.js >/dev/null
  echo "[reproduzir] SAST…";           node scripts/sastScan.js >/dev/null
  echo "[reproduzir] security scan…";  node scripts/securityScan.js >/dev/null || echo "[reproduzir] security scan sem rede/falhou (no CI roda online)"
fi
PATTERN="${2:-test/*.test.js test/marco8/*.test.js}"
PGP="${REPRO_PG_PORT:-55432}"
DB=nayara_one_ci
SUPER=nayara_ci
SUPER_PW=nayara_ci_password
APP=nayara_ci_app
APP_PW=nayara_ci_app_password
MODE=""
CONTAINER=""
WORKDIR=""

cleanup() {
  if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$WORKDIR" ]; then
    "$PG_BIN/pg_ctl" -D "$WORKDIR/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
  fi
  echo "[reproduzir] banco descartável removido."
}
trap cleanup EXIT

if [ -z "${REPRO_FORCE_LOCAL:-}" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE="docker postgres:16"
  CONTAINER="nayara-repro-$$"
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_USER=$SUPER -e POSTGRES_PASSWORD=$SUPER_PW \
    -e POSTGRES_DB=$DB -p "$PGP:5432" postgres:16 >/dev/null
  for _ in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U $SUPER >/dev/null 2>&1 && break; sleep 1; done
  PSQL=(docker exec -i -e PGPASSWORD=$SUPER_PW "$CONTAINER" psql -U $SUPER -d $DB -v ON_ERROR_STOP=1)
else
  PG_BIN=""
  for d in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /usr/lib/postgresql/16/bin "$(dirname "$(command -v initdb 2>/dev/null || echo /x/x)")"; do
    if [ -x "$d/initdb" ]; then PG_BIN="$d"; break; fi
  done
  [ -n "$PG_BIN" ] || { echo "Nem docker nem initdb disponíveis — instale um dos dois."; exit 2; }
  MODE="cluster local descartável ($("$PG_BIN/postgres" --version))"
  WORKDIR="$(mktemp -d -t nayara-repro)"
  echo "$SUPER_PW" > "$WORKDIR/pw"
  "$PG_BIN/initdb" -D "$WORKDIR/data" -U $SUPER --pwfile="$WORKDIR/pw" --auth=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null
  "$PG_BIN/pg_ctl" -D "$WORKDIR/data" -o "-p $PGP -k $WORKDIR -c listen_addresses=127.0.0.1" -l "$WORKDIR/pg.log" -w start >/dev/null
  PGPASSWORD=$SUPER_PW "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGP" -U $SUPER $DB
  PSQL=(env PGPASSWORD=$SUPER_PW "$PG_BIN/psql" -h 127.0.0.1 -p "$PGP" -U $SUPER -d $DB -v ON_ERROR_STOP=1)
fi
echo "[reproduzir] Postgres pronto: $MODE na porta $PGP"

# Mesmo env do job do CI (.github/workflows/test.yml)
export NODE_ENV=development DB_HOST=127.0.0.1 DB_PORT="$PGP" DB_NAME=$DB DB_SSL=false
export JWT_ACCESS_SECRET=ci-access-secret-not-for-production JWT_REFRESH_SECRET=ci-refresh-secret-not-for-production
export JWT_ACCESS_TTL=15m JWT_REFRESH_TTL=7d PII_HASH_SECRET=ci-pii-hash-secret-not-for-production
export MFA_ENCRYPTION_KEY=47f62af2f91a7ac9bb6ca3db95498c3ab311d033dd97f7e101b062a84c4781e0
export FILES_ENCRYPTION_KEY=9c1d41a6e7b8f2035d6a9c0e4b7f81d2c3a5e8f0b1d4c7a9e2f5b8d1c4a7e0f3
export APP_API_PREFIX=/api CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production
unset DATABASE_ADMIN_URL DB_USER DB_PASS DB_PASSWORD PORT 2>/dev/null || true
# O .env/.env.migration.local da máquina NÃO pode vazar para o banco descartável (dotenv não
# sobrescreve variáveis já definidas): neutraliza toda chave deles que este script não definiu.
for f in .env .env.migration.local; do
  [ -f "$f" ] || continue
  for k in $(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" | cut -d= -f1); do
    if [ -z "${!k+x}" ]; then export "$k="; fi
  done
done

export DATABASE_URL="postgres://$SUPER:$SUPER_PW@127.0.0.1:$PGP/$DB"
echo "[reproduzir] migrations…"; npm run -s migrate > "${OUT%.log}.setup.log" 2>&1 || { tail -30 "${OUT%.log}.setup.log"; exit 1; }
echo "[reproduzir] seeds (base + regras + dois tenants)…"
node scripts/seed-dev.js >/dev/null
node scripts/seedBillingRules.js >/dev/null
node scripts/seedRealEstateRules.js >/dev/null
node scripts/seed-ci-two-tenants.js >/dev/null

echo "[reproduzir] role $APP NOSUPERUSER NOBYPASSRLS + GRANT por schema…"
"${PSQL[@]}" -q -c "CREATE ROLE $APP LOGIN PASSWORD '$APP_PW' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION" >/dev/null
for schema in $("${PSQL[@]}" -t -A -c "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'"); do
  "${PSQL[@]}" -q -c "GRANT USAGE ON SCHEMA \"$schema\" TO $APP; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA \"$schema\" TO $APP; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA \"$schema\" TO $APP;" >/dev/null
done

export DATABASE_URL="postgres://$APP:$APP_PW@127.0.0.1:$PGP/$DB" DB_USER=$APP DB_PASSWORD=$APP_PW NODE_ENV=test CI=true PORT=3011  # CI=true: o GitHub Actions sempre define
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo desconhecido)"
DIRTY="$({ git status --porcelain 2>/dev/null | grep -v "^??" || true; } | wc -l | tr -d " ")"
{
  echo "# Nayara One — resultado individual da suíte de testes (reprodução LOCAL, mesmo comando do CI)"
  echo "# commit avaliado (branch): $COMMIT (arquivos rastreados modificados: $DIRTY)"
  echo "# postgres: $MODE"
  echo "# usuário do banco na suíte: $APP (NOSUPERUSER NOBYPASSRLS)"
  echo "# node: $(node -v)  data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# padrão: $PATTERN  concorrência: $([ -n "${REPRO_SERIAL:-}" ] && echo 'serial (--test-concurrency=1)' || echo 'padrão do node, igual ao CI')"
  echo "#"
} > "$OUT"
CONC=""
[ -z "${REPRO_SERIAL:-}" ] || CONC="--test-concurrency=1"
set +e
# shellcheck disable=SC2086
node --test $CONC --test-reporter=spec --test-reporter-destination=stdout $PATTERN 2>&1 | tee -a "$OUT"
STATUS=${PIPESTATUS[0]}
set -e
echo "[reproduzir] saída em $OUT (status $STATUS)"
grep -E '^ℹ (tests|pass|fail|cancelled|skipped|todo)' "$OUT" || true
if [ -n "${REPRO_CAPTURA:-}" ]; then
  echo "[reproduzir] captura HTTP/serviço/SQL dos Marcos 4/5 no mesmo banco descartável…"
  node scripts/capturar-evidencias-marco45.js --out "${OUT%.log}.captura.json" 2>&1 | grep -v '^{"level"' || true
fi
node scripts/sanear-log-teste.js "$OUT" "${OUT%.log}.saneado.log" >/dev/null && echo "[reproduzir] versão saneada em ${OUT%.log}.saneado.log (sha256 do original no cabeçalho)"
exit "$STATUS"
