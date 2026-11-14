'use strict';

const { registerAgentHooks } = require('../agentHooks');
const { CODE } = require('./juridica.policy');

/**
 * Fechamento M5 (livro §11): quando o pedido é a comparação de vistorias montada pelo servidor (inspectionNay.service), o SERVIDOR
 * chama a tool legal.compareInspections antes da geração — o modelo só escreve sobre as diferenças que a tool trouxe como fonte (e a
 * checagem de fontes do orquestrador retira o que não for citado). Falha da tool encerra o run (nunca responder sem as vistorias).
 */
const COMPARE_PREFIX = /^Comparar vistorias: entrada ([0-9a-f-]{36}) x saída ([0-9a-f-]{36})\./i;

const compareInstruction = (entryInspectionId, exitInspectionId) =>
  `Comparar vistorias: entrada ${entryInspectionId} x saída ${exitInspectionId}. Aponte as diferenças entre a vistoria de entrada e a de saída, item a item, citando a fonte de cada uma. Não decida responsabilidade nem cobrança: uma pessoa valida.`;

async function serverTools(state) {
  const match = COMPARE_PREFIX.exec(String(state.parsed && state.parsed.input ? state.parsed.input : ''));
  if (!match) return [];
  return [{ name: 'legal.compareInspections', arguments: { entryInspectionId: match[1], exitInspectionId: match[2] } }];
}

let registered = false;
function registerJuridicaHooks() {
  if (registered) return;
  registered = true;
  registerAgentHooks(CODE, { serverTools, requiredServerTools: true });
}

module.exports = { registerJuridicaHooks, compareInstruction, serverTools };
