#!/usr/bin/env bash
# Esteira de governança (M9-D890, Guia §8 "Testes/CI"): um controle por chamada, o mesmo comando no CI e na máquina de quem desenvolve.
#
#   bash scripts/ci-governanca.sh <controle>
#   controles: calendar | lineage | dlp | bcp | openapi | flags | finops | accessibility | aud | adversarial | dod-f
#
# calendar/dlp/bcp/finops/aud rodam os testes do bloco num cluster PostgreSQL DESCARTÁVEL (scripts/withDisposableDb.js), nunca no banco compartilhado de desenvolvimento. Nesse banco NENHUM teste pode ficar
# pulado: o relatório JUnit é conferido e qualquer `skipped` reprova (GOV_CI_TEST_SKIPPED). JUnit e resumo ficam em docs/evidencias/ci/governanca/ (o CI os publica como artefato).
# Nenhuma etapa tolera falha: o código de saída do controle é o da etapa.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CONTROLE="${1:-}"
SAIDA="docs/evidencias/ci/governanca"
mkdir -p "$SAIDA"

resumo() {
  echo "$1" | tee -a "$SAIDA/resumo.md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

# Testes com banco descartável: $1 = nome do controle (nome do JUnit), demais = arquivos/globs de teste (expandidos pelo bash dentro do cluster).
testes_com_banco() {
  local nome="$1"; shift
  local porta="${GOV_CI_PORTA:-$((55000 + RANDOM % 2000))}"
  node scripts/withDisposableDb.js --port "$porta" -- env LOG_LEVEL=info \
    CI_TENANT_USERS_PASSWORD="${CI_TENANT_USERS_PASSWORD:-ci-tenant-users-password-not-for-production}" \
    CLAMAV_HOST="${CLAMAV_HOST:-127.0.0.1}" CLAMAV_PORT="${CLAMAV_PORT:-3310}" \
    bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test exec node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$0" "${@:1}"' \
    "$SAIDA/$nome.junit.xml" "$@"
  local conferencia
  conferencia="$(node scripts/governance-ci/checkJunit.js "$SAIDA/$nome.junit.xml")"
  echo "$conferencia"
  if echo "$conferencia" | grep -q '^NAO_APLICAVEL_NO_CI'; then
    resumo "- $nome: verde nos executados; ATENÇÃO, parte NÃO APLICÁVEL NO CI (artefato dos repositórios irmãos ausente, coberta na suíte local): $(echo "$conferencia" | tail -1)"
  else
    resumo "- $nome: verde, nenhum teste pulado ($SAIDA/$nome.junit.xml)"
  fi
}

case "$CONTROLE" in
  calendar)      testes_com_banco calendar test/marco9/governanca/m9d80[123].*.test.js ;;
  lineage)       npm run check:lineage && resumo "- lineage: verde" ;;
  dlp)           testes_com_banco dlp test/marco9/governanca/m9d82[0-5].*.test.js ;;
  bcp)           testes_com_banco bcp test/marco9/governanca/m9d83[0-4].*.test.js ;;
  openapi)
    if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [ -n "${GITHUB_BASE_REF:-}" ]; then
      git fetch --no-tags --depth=1 origin "$GITHUB_BASE_REF"
      npm run lint:openapi -- --base "origin/$GITHUB_BASE_REF" --candidate openapi/openapi.v1.yaml
    else
      npm run lint:openapi -- --base openapi/openapi.v1.yaml --candidate openapi/openapi.v1.yaml
    fi
    npm run test:contract
    resumo "- openapi: lint e contract test verdes" ;;
  flags)         npm run sync:flags && npm run check:flags -- --out "$SAIDA/flags-check.json" && resumo "- flags: verde" ;;
  finops)        testes_com_banco finops test/marco9/governanca/m9d86[123].*.test.js ;;
  accessibility)
    # As checagens de acessibilidade (axe, contraste, teclado, mensagens, a11yStatic) moram no Front (script test:a11y). Sem o Front a etapa FALHA, salvo no CI que declarou
    # CI_SEM_REPOS_IRMAOS=1 (workflow: a branch do Front ainda não está no remoto): aí diz NÃO APLICÁVEL, nunca verde.
    FRONT="${GOV_CI_FRONT:-../NayaraOne--FRONT}"
    if [ ! -d "$FRONT" ]; then
      if [ "${CI_SEM_REPOS_IRMAOS:-}" = "1" ]; then
        resumo "- accessibility: NÃO APLICÁVEL NO CI (NAO_APLICAVEL_NO_CI: Front ausente em $FRONT, CI_SEM_REPOS_IRMAOS=1); NÃO executou nenhuma checagem, coberta pelo test:a11y da suíte local do Front"
        exit 0
      fi
      echo "GOV_CI_FRONT_MISSING: repositório do Front não encontrado em $FRONT." >&2; exit 2
    fi
    grep -q '"test:a11y"' "$FRONT/package.json" || { echo "GOV_CI_A11Y_SCRIPT_MISSING: o package.json do Front não tem o script test:a11y." >&2; exit 2; }
    npm run test:a11y --prefix "$FRONT"
    resumo "- accessibility: verde (test:a11y do Front)" ;;
  aud)           testes_com_banco aud test/marco9/governanca/m9d809.aud*.test.js ;;
  adversarial)   node scripts/checkAdversarialMap.js --json "$SAIDA/adversarial-map.json" | tee "$SAIDA/adversarial-map.txt"
                 resumo "- adversarial: $(head -1 "$SAIDA/adversarial-map.txt")" ;;
  dod-f)         # M9-D940: o fechamento do bloco F (sobe o próprio banco descartável); etapa final do CI do marco. Itens ADIADO_MARCO_10 (DRY3 real, decisão DI-D940-6) e
                 # NAO_APLICAVEL_NO_CI (Maturacao ausente) aparecem na saída e no resumo, contados à parte; nunca "OK".
                 npm run check:dod-f | tee "$SAIDA/dod-f.txt"
                 resumo "- dod-f: bloco F sem item reprovado ($SAIDA/../dod-bloco-f.json); $(grep '^Contagem:' "$SAIDA/dod-f.txt")"
                 grep -E '^(ADIADO_MARCO_10|NAO_APLICAVEL_NO_CI) ' "$SAIDA/dod-f.txt" > "$SAIDA/dod-f.itens-a-parte.txt" || [ $? -eq 1 ]
                 while IFS= read -r l; do resumo "  - ${l:0:300}"; done < "$SAIDA/dod-f.itens-a-parte.txt" ;;
  *) echo "uso: bash scripts/ci-governanca.sh calendar|lineage|dlp|bcp|openapi|flags|finops|accessibility|aud|adversarial|dod-f" >&2; exit 2 ;;
esac
