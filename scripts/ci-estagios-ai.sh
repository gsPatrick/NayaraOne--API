#!/usr/bin/env bash
# Esteira de CI da NAY (M9-D044, Guia seção 15): lint, typecheck, migrations, tool schema, permissões, isolamento do RAG, injeção +
# adversarial, grounding golden, alucinação, orçamento/roteador, contrato de provider e privacidade/redação, nesta ordem, parando no primeiro
# vermelho; depois os portões de ambiente (DEV, LAB, red-team, production approval), que só conferem o registro humano em ai.release_gates.
#
#   bash scripts/ci-estagios-ai.sh [log] [--ate N | --de N] ...   (repassa os argumentos a scripts/ai-ci/executar.js)
#   AI_CI_RELEASE_DATABASE_URL=...  bash scripts/ci-estagios-ai.sh log --de 13    # só os portões de ambiente
#
# Os estágios com banco rodam num cluster descartável (nunca no .env). O log por estágio e o relatório JSON ficam arquivados.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-docs/evidencias/ci/esteira-ai.log}"
[ "$#" -gt 0 ] && shift
RELATORIO="${LOG%.log}.json"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

PORTA="${AI_CI_PORTA:-$((55000 + RANDOM % 2000))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=info \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}" CLAMAV_PORT="${CLAMAV_PORT:-3310}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/ai-ci/executar.js --log "$0" --relatorio "$1" "${@:2}"' "$LOG" "$RELATORIO" "$@"
