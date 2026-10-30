'use strict';

/**
 * Autochecagem da NAY (M9-D047, Guia §19, livro 273 a 277): as quatro perguntas respondidas por fatos, nunca por declaração.
 *  1. "Marcelo consegue fazer sozinho?": NÃO é calculada aqui; é a saída do cálculo único da M9-D258 no escopo `ia-nay` (com a condição do livro).
 *  2. "Está blindado?": SIM só com os itens 3, 7, 12 e 14 do DoD verdes e o red-team (M9-D046) aprovado.
 *  3. "Tem caminho técnico?": SIM se o mapa de passos e sprints da M9-D045 tem 100% das demandas do bloco mapeadas.
 *  4. "Outro programador assume?": SIM se existem o _PLANO.md, as demandas D001 a D047 completas e a ordem (o mapa da M9-D045).
 */
const { compute } = require('../../int-autocheck/lib/compute');
const { ESCOPOS } = require('../../int-autocheck/lib/escopos');
const { verificacao, falhasDasDemandas, falhasDoMapa } = require('../../int-autocheck/lib/verificacao');

/** Texto do livro (palavra por palavra) de cada pergunta e a resposta SIM; a da pergunta 1 vem do cálculo da M9-D258. */
const PERGUNTAS = Object.freeze({
  1: { texto: 'Marcelo consegue fazer sozinho?' },
  2: { texto: 'Está blindado?', sim: 'SIM para brechas previsíveis, condicionado aos testes/red-team.' },
  3: { texto: 'Tem caminho técnico?', sim: 'SIM: arquitetura, ordem, tools, RAG, memória, approval, testes, CI e sprints.' },
  4: { texto: 'Outro programador assume?', sim: 'SIM com Livro Mestre + Guia.' },
});
const ITENS_DA_BLINDAGEM = Object.freeze([3, 7, 12, 14]);

const pergunta = (n, verificacoes, resposta) => {
  const ok = verificacoes.every((v) => v.ok);
  return { n, texto: PERGUNTAS[n].texto, ok, resposta: ok ? resposta : 'NÃO.', verificacoes };
};

function blindado(itens, amb) {
  const porN = new Map(itens.map((i) => [i.n, i]));
  const verdes = ITENS_DA_BLINDAGEM.map((n) => {
    const it = porN.get(n);
    return verificacao(`item ${n} do DoD (${it ? it.item : 'ausente'}) verde`, it ? it.falhas : [`item ${n} ausente da matriz`]);
  });
  return pergunta(2, [...verdes, verificacao('o red-team (M9-D046) aprovado', amb.redTeam())], PERGUNTAS[2].sim);
}

function caminho(amb) {
  return pergunta(3, [verificacao('o mapa de passos e sprints (M9-D045) tem 100% das demandas D001 a D047 mapeadas', falhasDoMapa(amb.mapa('ia-nay')))], PERGUNTAS[3].sim);
}

function programador(amb) {
  const esc = ESCOPOS['ia-nay'];
  return pergunta(4, [
    verificacao('existe o _PLANO.md do Marco 9', amb.existeDocumento('plano') ? [] : ['_PLANO.md do Marco 9 ausente']),
    verificacao(`as demandas ${esc.faixa} têm as 12 seções preenchidas e dependências existentes`, falhasDasDemandas(amb, esc)),
    verificacao('existe a ordem de execução (mapa de passos e sprints da M9-D045)', amb.mapa('ia-nay').erro ? [amb.mapa('ia-nay').erro] : []),
  ], PERGUNTAS[4].sim);
}

/** { ok, perguntas }: a 1 é a da M9-D258 (escopo ia-nay); as demais saem dos fatos do DoD. */
function autochecar(itens, amb) {
  const doBloco = compute({ escopo: 'ia-nay', ambiente: amb }).perguntas[0];
  const perguntas = [{ n: 1, texto: PERGUNTAS[1].texto, ok: doBloco.ok, resposta: doBloco.resposta, verificacoes: doBloco.verificacoes }, blindado(itens, amb), caminho(amb), programador(amb)];
  return { ok: perguntas.every((p) => p.ok), perguntas };
}

module.exports = { autochecar, PERGUNTAS, ITENS_DA_BLINDAGEM };
