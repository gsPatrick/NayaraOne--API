#!/usr/bin/env bash
# Ordem do caderno do Marco 8, dentro do job de teste:
# adapter, elegibilidade, submissão, webhook, status, comissão/financeiro,
# multiempresa, o restante da suíte (nada fica de fora) e os failure drills.
# Cada arquivo de teste entra uma vez.
set -euo pipefail

LOG="${1:-test-results.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Um arquivo por vez (--test-concurrency=1), como a bateria por lotes da entrega, com teto por teste (--test-timeout, 15 min: travamento
# vira falha visível). Ensaio de 15/11/2026: em paralelo, num banco só, os arquivos se atropelavam (89 falhas; no GitHub a suíte ficou
# parada até o limite de 6 h); em série, num banco só, uns 15 arquivos herdavam o que os anteriores gravaram (MFA ligado, papéis, histórico
# de pagamentos). Com CI_ISOLAR_ADMIN_URL (superusuário do banco do CI), CADA arquivo roda num banco clonado do banco já migrado e semeado
# (CREATE DATABASE ... TEMPLATE, ~1 s) e o clone é apagado no fim: nenhum arquivo depende da ordem. Sem a variável, um banco só (como antes).
NODE_TEST=(node --test --test-concurrency=1 --test-timeout=900000 --test-reporter=spec --test-reporter-destination=stdout)
FALHOU=0
url_com_banco() { node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$1" "$2"; }

# Arquivos que desfazem e refazem PAPEL do cluster (o papel vale para todos os bancos): no clone o papel ainda tem permissões no banco de
# origem e o DROP ROLE não acontece. Estes rodam no banco de origem, um por vez, como antes.
NO_BANCO_DE_ORIGEM=" test/analytics.m9d612.test.js "

roda_isolado() {
  local arquivo="$1" n="$2"
  local base clone admin_pg
  if [[ "$NO_BANCO_DE_ORIGEM" == *" ${arquivo} "* ]]; then
    "${NODE_TEST[@]}" "$arquivo" 2>&1 | tee -a "$LOG" || FALHOU=1
    return
  fi
  base=$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$DATABASE_URL")
  clone="ci_iso_${n}"
  admin_pg=$(url_com_banco "$CI_ISOLAR_ADMIN_URL" postgres)
  psql "$admin_pg" -Xq -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${base}' AND pid <> pg_backend_pid()" >/dev/null
  psql "$admin_pg" -Xq -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${clone}\" TEMPLATE \"${base}\"" >/dev/null
  local extra=()
  [ -n "${DATABASE_ADMIN_URL:-}" ] && extra+=("DATABASE_ADMIN_URL=$(url_com_banco "$DATABASE_ADMIN_URL" "$clone")")
  env DATABASE_URL="$(url_com_banco "$DATABASE_URL" "$clone")" ${extra[@]+"${extra[@]}"} "${NODE_TEST[@]}" "$arquivo" 2>&1 | tee -a "$LOG" || FALHOU=1
  psql "$admin_pg" -Xq -c "DROP DATABASE IF EXISTS \"${clone}\" WITH (FORCE)" >/dev/null || true
}

estagio() {
  local nome="$1"
  shift
  echo "# estagio: ${nome}" | tee -a "$LOG"
  if [ -n "${CI_ISOLAR_ADMIN_URL:-}" ]; then
    local i=0
    for arquivo in "$@"; do i=$((i + 1)); roda_isolado "$arquivo" "$i"; done
  else
    "${NODE_TEST[@]}" "$@" 2>&1 | tee -a "$LOG" || FALHOU=1
  fi
}

ja_rodou() {
  case "$1" in
    test/correspondent.providerAdapter.test.js|\
    test/correspondent.eligibility.test.js|\
    test/correspondent.submissions.test.js|\
    test/correspondent.webhooks.test.js|\
    test/marco8/statusMachine.test.js|\
    test/correspondent.commissions.test.js|\
    test/marco8/comissaoCiclo.test.js|\
    test/correspondent.domainEvents.test.js|\
    test/correspondent.fiscal.test.js|\
    test/correspondent.security.test.js|\
    test/marco8/tabelasRls.test.js|\
    test/correspondent.adversarialConsolidated.test.js|\
    test/correspondent.asyncWorkers.test.js)
      return 0
      ;;
  esac
  return 1
}

estagio "provider adapter contract tests" test/correspondent.providerAdapter.test.js
estagio "eligibility tests" test/correspondent.eligibility.test.js
estagio "submission idempotency" test/correspondent.submissions.test.js
estagio "webhook security/dedup" test/correspondent.webhooks.test.js
estagio "status ordering" test/marco8/statusMachine.test.js
estagio "commission/finance event" \
  test/correspondent.commissions.test.js \
  test/marco8/comissaoCiclo.test.js \
  test/correspondent.domainEvents.test.js \
  test/correspondent.fiscal.test.js
estagio "multi-company" \
  test/correspondent.security.test.js \
  test/marco8/tabelasRls.test.js

restante=()
for arquivo in test/*.test.js test/marco8/*.test.js; do
  if ja_rodou "$arquivo"; then
    continue
  fi
  restante+=("$arquivo")
done
estagio "restante da suíte, sem pular arquivo" "${restante[@]}"

estagio "sandbox failure drills" \
  test/correspondent.adversarialConsolidated.test.js \
  test/correspondent.asyncWorkers.test.js

exit "$FALHOU"
