#!/usr/bin/env bash
# Esteira do jurídico (Guia do Marco 5, §17): roda scripts/ci-juridico/executar.js dentro de um PostgreSQL descartável (nunca o .env nem o banco compartilhado).
#
#   bash scripts/ci-estagios-juridico.sh [relatorio.json] [--de N] [--ate N] [--release]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELATORIO="${1:-docs/evidencias/ci/esteira-juridico.json}"
[ "$#" -gt 0 ] && shift
PORTA="${JUR_CI_PORTA:-$((55000 + RANDOM % 900))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/ci-juridico/executar.js --relatorio "$0" "$@"' "$RELATORIO" "$@"
