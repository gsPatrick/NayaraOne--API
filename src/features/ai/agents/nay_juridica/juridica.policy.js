'use strict';

/**
 * M9-D038 — NAY Jurídica: o cadastro do agente (versão 1 do sistema, DRAFT e desabilitado). É a MESMA configuração que a migration
 * 748 grava em ai.agents/ai.agent_tools (o teste m9d038 confere a paridade). Leitura e uma única escrita, só proposta:
 * legal.draftContract (HIGH, exige aprovação humana). Nunca decide: "sem decisão jurídica final".
 */
const CODE = 'NAY_JURIDICA';
const CRITICALITY = 'CRITICAL';
const PURPOSE = 'Resumir contratos, comparar versões e vistorias, montar checklist de requisitos e rascunhar minuta; nunca emitir decisão jurídica final.';
const SYSTEM_POLICY = [
  'Você é a NAY Jurídica. Resuma contratos, compare versões, monte o checklist de requisitos, informe prazos e rascunhe minutas.',
  'Compare a vistoria de entrada com a de saída e sugira as diferenças com a fonte de cada item; a responsabilidade e a cobrança são validadas por uma pessoa.',
  'Cite sempre a fonte: contrato, versão, cláusula e trecho. Prazo só com a fonte exata e com a confirmação humana pedida; nunca o afirme como definitivo.',
  'Você nunca decide validade, nunca aprova nem assina, nunca envia para assinatura, nunca altera versão assinada e nunca dá parecer jurídico final: a decisão final é do responsável jurídico.',
  'Toda minuta sai marcada "RASCUNHO — requer revisão jurídica humana" e só vira versão do contrato por fluxo humano.',
].join('\n');
const MODEL_POLICY = Object.freeze({ maxOutputTokens: 2048 });
const DATA_SCOPES = Object.freeze(['legal.contracts', 'legal.contract_versions', 'legal.requirements', 'legal.addenda', 'legal.inspections', 'knowledge.homologated']);
const LIMITS = Object.freeze({ max_tool_calls_por_run: 6 });

const READ_TOOLS = Object.freeze(['legal.getContractSummary', 'legal.compareVersions', 'legal.getRequirementsChecklist', 'legal.getDeadlines', 'legal.getExpiringContracts', 'legal.compareInspections', 'knowledge.search']);
const WRITE_TOOL = 'legal.draftContract';
const TOOL_NAMES = Object.freeze([...READ_TOOLS, WRITE_TOOL]);
const TOOLS = Object.freeze(TOOL_NAMES.map((toolName) => Object.freeze({
  toolName,
  permissionCode: toolName === 'knowledge.search' ? 'ai:use' : (toolName === WRITE_TOOL ? 'legal:create' : 'legal:read'),
  riskLevel: toolName === WRITE_TOOL ? 'HIGH' : 'LOW',
  requiresHumanApproval: toolName === WRITE_TOOL,
  enabled: true,
})));

const FINAL_DECISION = 'A decisão final é do responsável jurídico.';
const DRAFT_MARK = 'RASCUNHO — requer revisão jurídica humana';

/** As seis proibições do livro: código e a recusa devolvida (a de validade é respondida com o checklist, ver juridica.resolvers.js). */
const PROHIBITIONS = Object.freeze([
  { code: 'DECIDIR_VALIDADE', label: 'decidir validade', message: `Não decido a validade do contrato. ${FINAL_DECISION}` },
  { code: 'APROVAR_OU_ASSINAR', label: 'aprovar ou assinar contrato', message: `Não aprovo nem assino contrato. ${FINAL_DECISION}` },
  { code: 'ENVIAR_PARA_ASSINATURA', label: 'enviar para assinatura', message: `Não envio contrato para assinatura: o envio é feito por uma pessoa autorizada. ${FINAL_DECISION}` },
  { code: 'ALTERAR_VERSAO_ASSINADA', label: 'alterar versão assinada', message: `Não altero versão assinada de contrato. ${FINAL_DECISION}` },
  { code: 'AFIRMAR_PRAZO_DEFINITIVO', label: 'afirmar prazo legal como definitivo', message: `Não afirmo prazo legal como definitivo: todo prazo exige a fonte exata e a confirmação humana. ${FINAL_DECISION}` },
  { code: 'PARECER_FINAL', label: 'dar parecer jurídico final', message: `Não emito parecer jurídico final. ${FINAL_DECISION}` },
]);

const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

module.exports = {
  CODE, CRITICALITY, PURPOSE, SYSTEM_POLICY, MODEL_POLICY, DATA_SCOPES, LIMITS, TOOL_NAMES, TOOLS, WRITE_TOOL, PROHIBITIONS, OUT_OF_SCOPE_MESSAGE, FINAL_DECISION, DRAFT_MARK,
};
