#!/usr/bin/env bash
# Esteira de CI do Marketing (M9-D438, Guia seção 12): lint, typecheck, migrations, automation idempotency, consent/suppression tests, factual grounding, public-field leakage tests, provider
# contract tests, frequency/quiet-hours, kill-switch e tracking tests (todo push e pull request); DEV, LAB e failure drills (branch de entrega), nesta ordem, parando no primeiro estágio vermelho.
#
#   bash scripts/ci-estagios-marketing.sh [log] [--entrega] [--de N] [--ate N] ...   (repassa os argumentos a scripts/marketing/ci/executar.js)
#
# Os estágios com banco rodam num cluster descartável (scripts/withDisposableDb.js), NUNCA no .env nem no banco compartilhado. O CI não faz deploy em produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-docs/evidencias/ci/esteira-marketing.log}"
[ "$#" -gt 0 ] && shift
RELATORIO="${LOG%.log}.json"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

PORTA="${MKT_CI_PORTA:-$((55000 + RANDOM % 2000))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=info \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}" CLAMAV_PORT="${CLAMAV_PORT:-3310}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/marketing/ci/executar.js --log "$0" --relatorio "$1" "${@:2}"' "$LOG" "$RELATORIO" "$@"
