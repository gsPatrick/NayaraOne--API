#!/usr/bin/env bash
# Esteira do Marco 3 — Pessoas, Imóveis, CRM e Radar (Guia do Marcelo do Marco 3, §16 CI/CD): lint, typecheck, migrations, people_dedup_tests,
# merge_tests, property_offer_tests, publication_gate_tests, crm_invariant_tests, radar_idempotency_tests, consent_tests, ai_grounding_tests,
# multi_company_tests, security_scan, deploy_DEV, deploy_LAB, load_tests e production_approval, nesta ordem, parando na primeira vermelha.
# Roda scripts/ci-marco3/executar.js dentro de um PostgreSQL DESCARTÁVEL (scripts/withDisposableDb.js; porta M3_CI_PORTA, padrão sorteado
# entre 55000 e 55899), nunca no .env nem no banco compartilhado, com a role de runtime sem bypass de RLS e o seed fictício de dois tenants.
#
#   bash scripts/ci-estagios-marco3.sh [relatorio.json] [--de N] [--ate N] [--release]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELATORIO="${1:-docs/evidencias/ci/esteira-marco3.json}"
[ "$#" -gt 0 ] && shift
PORTA="${M3_CI_PORTA:-$((55000 + RANDOM % 900))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}" CLAMAV_PORT="${CLAMAV_PORT:-3310}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/ci-marco3/executar.js --relatorio "$0" "$@"' "$RELATORIO" "$@"
