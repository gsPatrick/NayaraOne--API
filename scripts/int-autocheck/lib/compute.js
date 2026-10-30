'use strict';

/**
 * compute (M9-D258): responde as perguntas da autochecagem a partir de FATOS lidos do `ambiente` (demandas, relatório da suíte offline, guardas, relatórios de contrato, estado do portão),
 * nunca de declaração. Função pura sobre o ambiente: o script usa o real (ambiente.js), o teste usa um falso. Devolve { escopo, ok, perguntas: [{ n, texto, ok, resposta, verificacoes }] }.
 */
const { PERGUNTAS, ESCOPOS } = require('./escopos');
const { marcelo } = require('./marcelo');
const { blindado, condicao } = require('./blindado');
const { caminho, programador } = require('./caminho');

const CALCULO = { 1: marcelo, 2: blindado, 3: caminho, 4: programador };

function respostaSim(n, esc, amb) {
  if (n === 1) return esc.respostaMarcelo;
  if (n === 2) return `SIM para brechas previsíveis, ${condicao(amb)}`;
  return PERGUNTAS[n].resposta;
}

function compute({ escopo = 'integracoes', ambiente } = {}) {
  const esc = ESCOPOS[escopo];
  if (!esc) throw new Error(`escopo desconhecido: ${escopo} (use ${Object.keys(ESCOPOS).join(' ou ')})`);
  const amb = ambiente || require('./ambiente').ambienteReal();
  const perguntas = esc.perguntas.map((n) => {
    const verificacoes = CALCULO[n](amb, esc);
    const ok = verificacoes.every((v) => v.ok);
    return { n, texto: PERGUNTAS[n].texto, ok, resposta: ok ? respostaSim(n, esc, amb) : 'NÃO.', verificacoes };
  });
  return { escopo: esc.nome, titulo: esc.titulo, ok: perguntas.every((p) => p.ok), perguntas };
}

module.exports = { compute };
