'use strict';

/**
 * M9-D045 — regra do portão do AI2: o agente piloto (NAY Comercial) sai com a allowlist SOMENTE de leitura e `ia.comercial.permitir_propostas`
 * Desligado. O livro: "só depois liberar proposals" (a liberação é do AI6, pela trava de homologação da M9-D034). Lê o cadastro real do piloto,
 * as definições reais das tools e o padrão real do parâmetro; não lê banco.
 */
function verificarPiloto({ politica, definicoes, padroes, chave } = {}) {
  const pol = politica || require('../../../src/features/ai/agents/nay_comercial/comercial.policy');
  const defs = definicoes || [...require('../../../src/features/ai/tools/definitions').INITIAL_DEFINITIONS, ...require('../../../src/features/ai/tools/definitions/agentTools').AGENT_TOOL_DEFINITIONS];
  const key = chave || require('../../../src/features/ai/agents/nay_comercial/comercial.settings').COMERCIAL_KEYS.allowProposals;
  const defaults = padroes || require('../../../src/features/ai/ai.settings').AI_SETTING_DEFAULTS;
  const motivos = [];
  const tools = pol.TOOLS || [];
  if (!tools.length) motivos.push('a allowlist do agente piloto está vazia');
  for (const t of tools) {
    const def = defs.find((d) => d.name === t.toolName);
    if (!def) motivos.push(`tool ${t.toolName} da allowlist do piloto não existe no registro`);
    else if (def.category !== 'READ') motivos.push(`tool de escrita ${t.toolName} (categoria ${def.category}) na allowlist do piloto`);
    if (t.requiresHumanApproval === true) motivos.push(`tool ${t.toolName} da allowlist do piloto exige aprovação humana (é de escrita)`);
  }
  if (defaults[key] !== false) motivos.push(`${key} não está Desligado por padrão (valor ${JSON.stringify(defaults[key])})`);
  return { ok: motivos.length === 0, motivos, tools: tools.map((t) => t.toolName) };
}

module.exports = { verificarPiloto };
