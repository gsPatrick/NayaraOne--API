#!/usr/bin/env bash
# Captura ao vivo do fechamento do Marco 4 no Postgres descartável (porta 5527; API em processo na 5528).
#   bash scripts/fechamento-m4/rodar.sh <saida.json>
# Usa os usuários fictícios do seed de dois tenants (credencial só do banco descartável, mesma da esteira do CI).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-scripts/fechamento-m4/captura-descartavel.json}"
node scripts/withDisposableDb.js --port "${CAPTURA_PG_PORT:-5527}" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" CAPTURA_PORT="${CAPTURA_PORT:-5528}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node scripts/fechamento-m4/capturar.js --out "$0"' "$OUT"
node scripts/fechamento-m4/conferir-cobertura.js "$OUT"
