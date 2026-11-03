#!/usr/bin/env bash
# Ordem do caderno do Marco 8, dentro do job de teste:
# adapter, elegibilidade, submissão, webhook, status, comissão/financeiro,
# multiempresa, o restante da suíte (nada fica de fora) e os failure drills.
# Cada arquivo de teste entra uma vez.
set -euo pipefail

LOG="${1:-test-results.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

estagio() {
  local nome="$1"
  shift
  echo "# estagio: ${nome}" | tee -a "$LOG"
  node --test --test-reporter=spec --test-reporter-destination=stdout "$@" 2>&1 | tee -a "$LOG"
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
