#!/usr/bin/env bash
# Esteira de Obras (Guia do Marco 6, §13): roda scripts/ci-obras/executar.js dentro de um PostgreSQL descartável (nunca o .env nem o banco compartilhado).
#
#   bash scripts/ci-estagios-obras.sh [relatorio.json] [--de N] [--ate N] [--release]
# Portas (opcionais): OBR_CI_PORTA (cluster da esteira), OBR_CI_PORTA_DRILL (drill de restore: ela e a seguinte), OBR_CI_PORTA_HTTP (API real dos testes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELATORIO="${1:-docs/evidencias/ci/esteira-obras.json}"
[ "$#" -gt 0 ] && shift
PORTA="${OBR_CI_PORTA:-$((55000 + RANDOM % 900))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/ci-obras/executar.js --relatorio "$0" "$@"' "$RELATORIO" "$@"
