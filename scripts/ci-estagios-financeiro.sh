#!/usr/bin/env bash
# Esteira de CI do Financeiro (Marco 4, Guia do Marcelo §17): lint, typecheck, unit_tests, db_migrations, finance_integration_tests, concurrency_tests,
# idempotency_tests, bank_adapter_contract_tests, reconciliation_tests, closed_period_tests, multi_company_tests, security_scan, deploy_DEV, deploy_LAB,
# failure_drills, pentest e production_approval, nesta ordem, parando no primeiro estágio vermelho.
#
#   bash scripts/ci-estagios-financeiro.sh [log] [--entrega|--aprovacao|--todos] [--de N] [--ate N]   (repassa os argumentos a scripts/financeiro/ci/executar.js)
#
# Os estágios rodam num cluster PostgreSQL descartável (scripts/withDisposableDb.js; porta FIN_CI_PORTA, padrão sorteado entre 55000 e 56999), NUNCA no .env
# nem no banco compartilhado, com a role de runtime sem bypass de RLS e o seed fictício de dois tenants. O drill de restore do estágio 15 sobe os próprios
# clusters em FIN_CI_PORTA_DRILL e FIN_CI_PORTA_DRILL+1 (padrão sorteado entre 57000 e 57998). O CI não faz deploy em produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-docs/evidencias/ci/esteira-financeiro.log}"
[ "$#" -gt 0 ] && shift
RELATORIO="${LOG%.log}.json"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

PORTA="${FIN_CI_PORTA:-$((55000 + RANDOM % 2000))}"
export FIN_CI_PORTA_DRILL="${FIN_CI_PORTA_DRILL:-$((57000 + (RANDOM % 500) * 2))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  FIN_CI_PORTA_DRILL="$FIN_CI_PORTA_DRILL" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/financeiro/ci/executar.js --log "$0" --relatorio "$1" "${@:2}"' "$LOG" "$RELATORIO" "$@"
