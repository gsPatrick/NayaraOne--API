'use strict';

/** Fecha o DoD da NAY (M9-D047): valida a matriz, avalia os 16 itens e a autochecagem, e devolve a saída pronta. Matriz malformada reprova antes de qualquer item. */
const { problemasDaMatriz } = require('./matriz');
const { avaliarItens } = require('./avaliar');
const { autochecar } = require('./autochecagem');
const { renderizar, CODIGO } = require('./saida');
const { limpar } = require('../../int-autocheck/lib/saida');

function executar(matriz, amb) {
  const problemas = problemasDaMatriz(matriz);
  if (problemas.length) return { code: 1, stdout: '', stderr: `${limpar(problemas.map((p) => `${CODIGO} matriz do DoD recusada: ${p}`).join('\n'))}\n` };
  const itens = avaliarItens(matriz, amb);
  // CI que só tem a API (CI_SEM_REPOS_IRMAOS=1, demandas ausentes): os itens são avaliados só pelos testes verdes e pelo relatório adversarial; a parte das demandas e a autochecagem saem NAO_APLICAVEL_NO_CI.
  return renderizar({ itens, autochecagem: amb.semDemandas ? null : autochecar(itens, amb), semDemandas: Boolean(amb.semDemandas) });
}

module.exports = { executar };
