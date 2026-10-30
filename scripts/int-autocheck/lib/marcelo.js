'use strict';

/**
 * Pergunta 1, "Marcelo consegue fazer sozinho?" (livro 511 e, no escopo ia-nay, 273). A M9-D258 é a única dona do cálculo: SIM somente se (a) cada demanda do bloco tem as 12 seções
 * e dependências existentes, (b) a suíte roda offline contra sandboxes com 0 chamadas externas, (c) há runbook de 7 seções (por provider, ou o da operação da IA) e (d) o _PLANO.md e o
 * mapa de passos e sprints existem.
 */
const { verificacao, falhasDasDemandas } = require('./verificacao');
const { problemasOffline } = require('./relatorio');

function marcelo(amb, esc) {
  const runbooks = esc.runbook ? amb.runbookIa().map((p) => `runbook da operação da IA: ${p}`) : amb.runbooksFaltando().map((c) => `runbook ausente: ${c}`);
  const mapa = amb.mapa(esc.nome);
  const plano = [...(amb.existeDocumento('plano') ? [] : ['_PLANO.md do Marco 9 ausente']), ...(mapa.erro ? [`mapa de passos e sprints: ${mapa.erro}`] : [])];
  return [
    verificacao(`as demandas ${esc.faixa} têm as 12 seções preenchidas e dependências existentes`, falhasDasDemandas(amb, esc)),
    verificacao(`a suíte roda offline contra ${esc.sandbox}, com 0 chamadas externas`, problemasOffline(amb.relatorioOffline(esc.nome), amb.arquivosEsperados(esc.nome))),
    verificacao(esc.runbook ? 'existe o runbook de operação da IA com as 7 seções' : 'existe runbook de 7 seções para cada provider do catálogo', runbooks),
    verificacao('existem o _PLANO.md do Marco 9 e o mapa de passos e sprints', plano),
  ];
}

module.exports = { marcelo };
