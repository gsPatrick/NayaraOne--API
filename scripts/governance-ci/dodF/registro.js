'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RAIZ_API } = require('./config');
const { contagem, situacaoDe } = require('./index');

/** Hash do commit em que o fechamento rodou (HEAD do repositório da API); sem git, "unknown". */
function commitAtual() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ_API, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_e) { return 'unknown'; }
}

/** VERDE só com todos OK; com item adiado ou não aplicável o resultado diz isso (nunca "VERDE" puro); com código diferente de 0, VERMELHO. */
function resultadoGeral(codigo, resultados) {
  if (codigo !== 0) return 'VERMELHO';
  const c = contagem(resultados);
  return c.ADIADO_MARCO_10 ? 'VERDE_COM_ADIADO_MARCO_10' : c.NAO_APLICAVEL_NO_CI ? 'VERDE_COM_NAO_APLICAVEL_NO_CI' : 'VERDE';
}

/** Registro da execução (M9-D940 §3.3): data, commit, código de saída e uma entrada por item. Sem dado pessoal nem segredo. Escrita atômica. */
function gravar(arquivo, { resultados, codigo }, agora = new Date()) {
  const corpo = {
    comando: 'node scripts/checkDodBlocoF.js',
    generated_at: agora.toISOString(),
    commit: commitAtual(),
    exit_code: codigo,
    resultado: resultadoGeral(codigo, resultados),
    contagem: contagem(resultados),
    itens: resultados.map((r) => ({ item: r.nome, resultado: situacaoDe(r), detalhe: r.motivo })),
  };
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(corpo, null, 2)}\n`);
  fs.renameSync(tmp, arquivo);
  return corpo;
}

module.exports = { gravar, commitAtual, resultadoGeral };
