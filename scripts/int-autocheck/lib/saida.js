'use strict';

/**
 * Saída da autochecagem (M9-D258): cada pergunta com o texto do livro e SIM/NÃO, seguida de uma linha por verificação (OK ou FALTA, com os detalhes da falha). A saída nunca leva segredo
 * (biblioteca única de redaction), caminho absoluto de máquina nem payload: tudo passa por `limpar` antes de sair.
 */
const path = require('node:path');
const { redactText } = require('../../../src/shared/redaction');
const { CODIGO, MENSAGENS } = require('./escopos');

const RAIZ_API = path.resolve(__dirname, '..', '..', '..');
const RAIZ_MARCO = path.resolve(RAIZ_API, '..');
/** Caminho absoluto de Unix ou de Windows: vira o trecho relativo ou um marcador. */
const ABSOLUTO = /(?:\/(?:Users|home|private|var|tmp|opt|root|mnt)\/[^\s'"`)\]]+|[A-Za-z]:\\[^\s'"`)\]]+)/g;

function limpar(texto) {
  let t = String(texto);
  for (const raiz of [RAIZ_API, RAIZ_MARCO]) t = t.split(`${raiz}${path.sep}`).join('').split(raiz).join('.');
  return redactText(t.replace(ABSOLUTO, '[caminho]'));
}

/** Linhas de stdout e stderr: as quatro perguntas e, para cada verificação reprovada, o código INTEGRATION_DOD_AUTOCHECK_FAILED com a mensagem da pergunta. */
function renderizar(resultado) {
  const out = [`# ${resultado.titulo} (escopo: ${resultado.escopo})`];
  const err = [];
  for (const p of resultado.perguntas) {
    out.push(`${p.texto} ${p.resposta}`);
    for (const v of p.verificacoes) {
      out.push(`  ${v.ok ? 'OK   ' : 'FALTA'} ${v.nome}`);
      v.detalhes.slice(0, 20).forEach((d) => out.push(`         - ${d}`));
      if (v.detalhes.length > 20) out.push(`         - ... e mais ${v.detalhes.length - 20}`);
      if (!v.ok) err.push(`${CODIGO} ${MENSAGENS[p.n](v.nome)}${v.detalhes.length ? ` (${v.detalhes.slice(0, 3).join('; ')})` : ''}`);
    }
  }
  const sims = resultado.perguntas.filter((p) => p.ok).length;
  out.push(`${sims} de ${resultado.perguntas.length} perguntas com resposta SIM`);
  return { code: resultado.ok ? 0 : 1, stdout: `${limpar(out.join('\n'))}\n`, stderr: err.length ? `${limpar(err.join('\n'))}\n` : '' };
}

module.exports = { renderizar, limpar };
