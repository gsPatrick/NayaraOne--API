#!/usr/bin/env bash
# Esteira do jurídico (Guia do Marco 5, §17): roda as 18 etapas de scripts/ci-juridico/executar.js, na ordem do livro, dentro de um
# PostgreSQL descartável (nunca o .env nem o banco compartilhado). O relatório e as evidências (<relatorio>-evidencias/) ficam FORA do
# repositório por padrão: a árvore precisa continuar limpa para o drill de restore, o pentest e o portão de produção.
#
#   bash scripts/ci-estagios-juridico.sh [relatorio.json] [--release] [--de N] [--ate N]
# Portas: JUR_CI_PORTA (cluster da esteira), JUR_CI_PORTA_DRILL (drill de restore: usa ela e a seguinte), JUR_CI_PORTA_HTTP_DEV/LAB.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELATORIO="${1:-${TMPDIR:-/tmp}/esteira-juridico/esteira-juridico.json}"
[ "$#" -gt 0 ] && shift
PORTA="${JUR_CI_PORTA:-$((55000 + RANDOM % 900))}"
node scripts/withDisposableDb.js --port "$PORTA" -- env LOG_LEVEL=error \
  CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
  bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/ci-juridico/executar.js --relatorio "$0" "$@"' "$RELATORIO" "$@"
