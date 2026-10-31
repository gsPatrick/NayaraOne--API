#!/usr/bin/env bash
# Regressão completa da API em banco PostgreSQL DESCARTÁVEL, com pré-requisitos conferidos em voz alta.
#
# Uso:   bash scripts/regressao-descartavel.sh [arquivo-de-log.log]
# Saída: <arquivo>.log (log completo, reporter spec + resumo) e <arquivo>.loteN.log (um por lote).
# Guia:  docs/REPRODUZIR_REGRESSAO.md
#
# O que faz:
#   1. FALHA ALTO (exit 2) se faltar Node >= 20, PostgreSQL (initdb/pg_ctl/psql) ou o ClamAV em
#      127.0.0.1:3310 — nunca "pula" em silêncio. Sem tesseract/pdftotext também falha
#      (os testes dos leitores de documentos ficariam pulados), a menos que REGRESSAO_PERMITIR_SEM_OCR=1.
#   2. Divide os arquivos test/*.test.js e test/marco8/*.test.js em N lotes (padrão 4).
#   3. Para cada lote sobe um cluster PostgreSQL novo (scripts/withDisposableDb.js: migrations do zero,
#      seeds, role de runtime NOSUPERUSER/NOBYPASSRLS), roda seed-ci-two-tenants e a suíte do lote, e apaga o cluster.
#   4. Soma testes/passados/falhas/pulados/cancelados de todos os lotes. Sai com 0 só se
#      falhas = 0, canceladas = 0, pulados = 0 e todos os lotes terminaram com resumo.
#
# Variáveis (todas opcionais):
#   REGRESSAO_LOTES=4          número de lotes
#   REGRESSAO_PARALELO=1       lotes simultâneos (cada um em seu próprio cluster/porta); 1 = em série
#   REGRESSAO_PORTA_BASE=...   primeira porta (padrão: aleatória entre 55000 e 56900); lote i usa base+i
#   REGRESSAO_PADRAO="..."     lista de arquivos de teste em vez da suíte inteira
#   DRILL_PG_BIN=...           pasta bin do PostgreSQL (se não estiver nos caminhos padrão)
#   CLAMAV_HOST / CLAMAV_PORT  endereço do clamd (padrão 127.0.0.1 / 3310)
set -uo pipefail

API_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$API_ROOT"
OUT="${1:-$API_ROOT/regressao-resultado.log}"
LOTES="${REGRESSAO_LOTES:-4}"
PARALELO="${REGRESSAO_PARALELO:-1}"
BASE="${REGRESSAO_PORTA_BASE:-$((55000 + RANDOM % 1900))}"
CLAM_HOST="${CLAMAV_HOST:-127.0.0.1}"
CLAM_PORT="${CLAMAV_PORT:-3310}"

faltou() { echo "[regressao] ERRO: $1" >&2; echo "[regressao] Veja docs/REPRODUZIR_REGRESSAO.md" >&2; exit 2; }

# --- 1. pré-requisitos -------------------------------------------------------------------------
command -v node >/dev/null || faltou "node não encontrado (necessário Node >= 20)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || faltou "Node $(node -v) é antigo demais (necessário >= 20)."
[ -d node_modules ] || faltou "node_modules ausente — rode 'npm ci' primeiro."

PG_BIN="${DRILL_PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin; do
    [ -x "$d/initdb" ] && { PG_BIN="$d"; break; }
  done
fi
[ -n "$PG_BIN" ] && [ -x "$PG_BIN/initdb" ] && [ -x "$PG_BIN/pg_ctl" ] && [ -x "$PG_BIN/psql" ] \
  || faltou "binários do PostgreSQL (initdb, pg_ctl, psql) não encontrados. Instale o PostgreSQL 16 ou 17 ou defina DRILL_PG_BIN=<pasta bin>."
export DRILL_PG_BIN="$PG_BIN"
PG_VERSION="$("$PG_BIN/postgres" --version 2>/dev/null || echo 'postgres ?')"

PONG="$( (exec 3<>"/dev/tcp/$CLAM_HOST/$CLAM_PORT" && printf 'PING\n' >&3 && read -r -t 5 resp <&3 && printf '%s' "${resp//[[:space:]]/}") 2>/dev/null || true)"
[ "$PONG" = "PONG" ] || faltou "o ClamAV (clamd) não respondeu PONG em $CLAM_HOST:$CLAM_PORT. Os testes de upload dependem dele."

if [ -z "${REGRESSAO_PERMITIR_SEM_OCR:-}" ]; then
  command -v tesseract >/dev/null && command -v pdftotext >/dev/null \
    || faltou "tesseract (com idioma por) e/ou pdftotext (poppler) ausentes: os testes dos leitores de documentos ficariam PULADOS. Instale-os (ou REGRESSAO_PERMITIR_SEM_OCR=1 para aceitar os pulos)."
fi

# --- 2. lotes ----------------------------------------------------------------------------------
if [ -n "${REGRESSAO_PADRAO:-}" ]; then
  # shellcheck disable=SC2086
  FILES=( $(ls $REGRESSAO_PADRAO | sort) )
else
  FILES=( $(ls test/*.test.js test/marco8/*.test.js | sort) )
fi
TOTAL_ARQ=${#FILES[@]}
[ "$TOTAL_ARQ" -gt 0 ] || faltou "nenhum arquivo de teste encontrado."
[ "$LOTES" -le "$TOTAL_ARQ" ] || LOTES="$TOTAL_ARQ"
POR_LOTE=$(( (TOTAL_ARQ + LOTES - 1) / LOTES ))

for ((i = 1; i <= LOTES; i++)); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$((BASE + i))") 2>/dev/null; then
    faltou "a porta $((BASE + i)) já está em uso. Defina REGRESSAO_PORTA_BASE com outra faixa livre."
  fi
done

# O .env da máquina NÃO pode vazar para os testes (dotenv não sobrescreve variável já definida).
if [ -f .env ]; then
  for k in $(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env | cut -d= -f1); do
    [ -z "${!k+x}" ] && export "$k="
  done
fi

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo desconhecido)"
DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
INICIO="$(date +%s)"
{
  echo "# Nayara One — regressão completa em banco descartável"
  echo "# commit avaliado: $COMMIT (arquivos rastreados modificados: $DIRTY)"
  echo "# postgres: $PG_VERSION (cluster descartável por lote; role de runtime NOSUPERUSER NOBYPASSRLS)"
  echo "# node: $(node -v)  clamd: $CLAM_HOST:$CLAM_PORT (PONG)  tesseract: $(tesseract --version 2>&1 | head -1)"
  echo "# arquivos de teste: $TOTAL_ARQ em $LOTES lotes (paralelo=$PARALELO, porta base $BASE)  data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$OUT"

rodar_lote() {
  local i="$1"; shift
  local port=$((BASE + i)) log="${OUT%.log}.lote$i.log"
  echo "[regressao] lote $i/$LOTES: $# arquivos, cluster descartável na porta ${port} ..."
  node scripts/withDisposableDb.js --port "$port" -- env LOG_LEVEL=info \
    CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production \
    CLAMAV_HOST="$CLAM_HOST" CLAMAV_PORT="$CLAM_PORT" CI=true \
    bash -c 'node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 --test-reporter=spec "$@"' _ "$@" \
    > "$log" 2>&1
  echo "$?" > "$log.exit"
}

PIDS=()
for ((i = 1; i <= LOTES; i++)); do
  ini=$(( (i - 1) * POR_LOTE ))
  fatia=( "${FILES[@]:ini:POR_LOTE}" )
  [ "${#fatia[@]}" -gt 0 ] || continue
  rodar_lote "$i" "${fatia[@]}" &
  PIDS+=($!)
  while [ "$(jobs -rp | wc -l)" -ge "$PARALELO" ]; do sleep 2; done
done
wait

# --- 3. consolidação ---------------------------------------------------------------------------
soma() { # $1 = rótulo do resumo
  local total=0 v
  for ((i = 1; i <= LOTES; i++)); do
    v="$(grep -E "^ℹ $1 [0-9]+" "${OUT%.log}.lote$i.log" 2>/dev/null | tail -1 | awk '{print $3}')"
    total=$(( total + ${v:-0} ))
  done
  echo "$total"
}
SEM_RESUMO=0
for ((i = 1; i <= LOTES; i++)); do
  l="${OUT%.log}.lote$i.log"
  [ -f "$l" ] || { SEM_RESUMO=$((SEM_RESUMO + 1)); echo "[regressao] ERRO: lote $i não gerou log." >&2; continue; }
  grep -qE "^ℹ tests [0-9]+" "$l" || { SEM_RESUMO=$((SEM_RESUMO + 1)); echo "[regressao] ERRO: lote $i terminou SEM resumo de testes (preparação do banco falhou?). Últimas linhas:" >&2; tail -15 "$l" >&2; }
  { echo; echo "######## LOTE $i (exit $(cat "$l.exit" 2>/dev/null || echo ?)) ########"; cat "$l"; } >> "$OUT"
done
T="$(soma tests)"; P="$(soma pass)"; F="$(soma fail)"; C="$(soma cancelled)"; S="$(soma skipped)"; TD="$(soma todo)"
FIM="$(date +%s)"
{
  echo
  echo "######## RESUMO CONSOLIDADO ########"
  echo "ℹ commit $COMMIT"
  echo "ℹ arquivos $TOTAL_ARQ  lotes $LOTES"
  echo "ℹ tests $T"
  echo "ℹ pass $P"
  echo "ℹ fail $F"
  echo "ℹ cancelled $C"
  echo "ℹ skipped $S"
  echo "ℹ todo $TD"
  echo "ℹ duração total $((FIM - INICIO)) s"
} | tee -a "$OUT"

if [ "$SEM_RESUMO" -ne 0 ] || [ "$F" -ne 0 ] || [ "$C" -ne 0 ] || [ "$S" -ne 0 ] || [ "$T" -eq 0 ]; then
  echo "[regressao] REPROVADA: falhas=$F canceladas=$C pulados=$S lotes sem resumo=$SEM_RESUMO. Veja ${OUT%.log}.loteN.log." >&2
  exit 1
fi
echo "[regressao] APROVADA: $P/$T testes, 0 falhas, 0 pulados."
