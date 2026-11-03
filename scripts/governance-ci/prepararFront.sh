#!/usr/bin/env bash
# Posiciona o Front (NayaraOne--FRONT) ao lado da API no CI, quando o repositório tem o que a governança lê dele; senão DECLARA a ausência (CI_SEM_REPOS_IRMAOS=1 no GITHUB_ENV).
#
#   bash scripts/governance-ci/prepararFront.sh
#
# O CI faz checkout só da API. O Front é público: o clone anônimo basta; FRONT_REPO_TOKEN (opcional) só entra se o repositório virar privado. Nenhum segredo é exigido nem inventado.
# A branch pedida é a de mesmo nome da API (ou FRONT_REF). O Front só vale se trouxer os marcadores abaixo (o que a D825 e o D851 leem); sem eles, ou sem a branch no remoto, o job
# segue com CI_SEM_REPOS_IRMAOS=1 e um aviso visível: os testes e a etapa que dependem do Front dizem NAO_APLICAVEL_NO_CI e continuam exigidos na suíte local. Nunca viram "passou".
set -euo pipefail

DONO="${GITHUB_REPOSITORY_OWNER:-gsPatrick}"
REF="${FRONT_REF:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-marco-9}}}"
DESTINO="${FRONT_DESTINO:-$(dirname "${GITHUB_WORKSPACE:-$PWD}")/NayaraOne--FRONT}"
MARCADORES=(lib/dlp/protectedValue.logic.js scripts/a11yStatic.js test/m9d851.axe.test.mjs)
URL="https://github.com/${DONO}/NayaraOne--FRONT.git"
[ -n "${FRONT_REPO_TOKEN:-}" ] && URL="https://x-access-token:${FRONT_REPO_TOKEN}@github.com/${DONO}/NayaraOne--FRONT.git"

declarar_ausencia() {
  echo "::warning title=Front ausente no CI::$1. CI_SEM_REPOS_IRMAOS=1: o que depende do Front sai como NAO_APLICAVEL_NO_CI (nao executado) e segue exigido na suite local."
  [ -n "${GITHUB_ENV:-}" ] && echo "CI_SEM_REPOS_IRMAOS=1" >> "$GITHUB_ENV"
  rm -rf "$DESTINO"
  exit 0
}

rm -rf "$DESTINO"
if ! GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$REF" "$URL" "$DESTINO" 2>/dev/null; then
  declarar_ausencia "a branch $REF do NayaraOne--FRONT nao existe no remoto (ou o repositorio nao e legivel sem token)"
fi
for m in "${MARCADORES[@]}"; do
  [ -e "$DESTINO/$m" ] || declarar_ausencia "o Front na branch $REF nao tem $m"
done
echo "Front posicionado em $DESTINO (branch $REF, $(git -C "$DESTINO" rev-parse --short HEAD)); a governança o exige por inteiro."
