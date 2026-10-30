#!/usr/bin/env bash
# Esteira de CI das integrações (M9-D254, Guia seção 11): lint, typecheck, contract tests dos adapters, segurança de webhook, idempotência do envio, retry e circuito, varredura de segredo e log,
# SSRF e sandbox dos providers, nesta ordem, parando na primeira etapa vermelha. Com --release (tag de release de UM provider, INT_CI_PROVIDER) roda DEV, LAB, failure drill e production approval;
# a última só habilita o botão de aprovação do Patrick: o CI não faz deploy em produção.
#
#   bash scripts/ci-estagios-integracoes.sh [log] [--release] [--de N] [--ate N] ...   (repassa os argumentos a scripts/int-ci/executar.js)
#
# As etapas com banco rodam num cluster descartável (scripts/withDisposableDb.js), nunca no .env nem no banco compartilhado.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-docs/evidencias/ci/esteira-integracoes.log}"
[ "$#" -gt 0 ] && shift
RELATORIO="${LOG%.log}.json"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

PORTA="${INT_CI_PORTA:-$((55000 + RANDOM % 2000))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=info \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}" CLAMAV_PORT="${CLAMAV_PORT:-3310}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/int-ci/executar.js --log "$0" --relatorio "$1" "${@:2}"' "$LOG" "$RELATORIO" "$@"
