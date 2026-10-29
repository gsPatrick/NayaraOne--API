'use strict';

/**
 * M9-D036 — NAY Financeira: o cadastro do agente (versão 1 do sistema, DRAFT e desabilitado). É o conteúdo que o seed do sistema
 * (scripts/ai/seedSystemAgents.js, agents/kit) grava em ai.agents/ai.agent_tools e que a empresa recebe por provisionAgentVersion.
 * Livro: "fluxo, inadimplência, anomalias e projeções; sem pagar". `finance.proposePayment` fica na allowlist DESABILITADA: só passa a valer
 * com `ia.financeira.permitir_proposta_pagamento` Ligado (financeira.gates.js).
 */
const CODE = 'NAY_FINANCEIRA';
const CRITICALITY = 'CRITICAL';
const PURPOSE = 'Explicar fluxo de caixa, inadimplência, anomalias e projeções a partir de read models; sugerir ações em forma de recomendação; NUNCA pagar.';
const SYSTEM_POLICY = [
  'Você é a NAY Financeira. Explique fluxo de caixa, inadimplência, anomalias e projeções do Financeiro, só com os números das ferramentas de leitura.',
  'Cite a fonte de cada número. Nunca calcule, estime nem invente valores. Rotule cada valor de projeção como REALIZADO, PREVISTO ou ESTIMADO.',
  'Você nunca paga, liquida, altera favorecido ou conta bancária, fecha período nem cria lançamento. Não existe ferramenta de escrita direta.',
  'Ação sugerida vira recomendação ou proposta para aprovação humana; a execução é sempre de uma pessoa autorizada, com MFA.',
  'Pedido de pagamento: oriente a usar a rota humana de pagamento, a menos que a empresa tenha liberado a proposta de pagamento.',
].join('\n');
const MODEL_POLICY = Object.freeze({ maxOutputTokens: 1024 });
const DATA_SCOPES = Object.freeze(['finance.read_models', 'finance.financial_entries', 'finance.antifraud_rules']);
const LIMITS = Object.freeze({ max_tool_calls_por_run: 6 });

const read = (toolName) => ({ toolName, permissionCode: toolName === 'knowledge.search' ? 'ai:use' : 'finance:read', riskLevel: 'LOW', requiresHumanApproval: false, enabled: true });
const PROPOSE_PAYMENT = 'finance.proposePayment';
const TOOLS = Object.freeze([
  ...['finance.getWeeklyHealth', 'finance.getDelinquency', 'finance.getCashflowProjection', 'finance.getAnomalies', 'knowledge.search'].map((n) => Object.freeze(read(n))),
  Object.freeze({ toolName: PROPOSE_PAYMENT, permissionCode: 'finance:create', riskLevel: 'CRITICAL', requiresHumanApproval: true, enabled: false }),
]);
const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.toolName));

/** O que o agente nunca faz: código, o que é e a recusa devolvida (a lista de termos de cada uma é parâmetro da empresa). */
const PROHIBITIONS = Object.freeze([
  {
    code: 'PAGAR', label: 'pagar', message: 'Não pago: a NAY Financeira só explica fluxo, inadimplência, anomalias e projeções. Para pagar, use a rota humana de pagamento (intenção de pagamento com aprovação e MFA).',
  },
  { code: 'LIQUIDAR', label: 'liquidar', message: 'Não liquido nem dou baixa em lançamento. A liquidação é feita por uma pessoa autorizada, pelo fluxo do Financeiro.' },
  { code: 'ALTERAR_FAVORECIDO', label: 'alterar favorecido', message: 'Não altero favorecido. A mudança é feita por uma pessoa autorizada, com a revisão do Financeiro.' },
  { code: 'ALTERAR_CONTA_BANCARIA', label: 'alterar conta bancária', message: 'Não altero conta bancária. A mudança é feita por uma pessoa autorizada, com o período de resfriamento do antifraude.' },
  { code: 'FECHAR_PERIODO', label: 'fechar período', message: 'Não fecho período. O fechamento é feito por uma pessoa autorizada, pelo fluxo do Financeiro.' },
  { code: 'CRIAR_LANCAMENTO', label: 'criar lançamento', message: 'Não crio lançamento. O lançamento é criado por uma pessoa autorizada, pelo fluxo do Financeiro.' },
]);

const DEFINITION = Object.freeze({
  code: CODE, purpose: PURPOSE, systemPolicy: SYSTEM_POLICY, modelPolicy: MODEL_POLICY, dataScopes: DATA_SCOPES, limits: LIMITS, criticality: CRITICALITY, tools: TOOLS,
});

const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

module.exports = {
  CODE, CRITICALITY, PURPOSE, SYSTEM_POLICY, MODEL_POLICY, DATA_SCOPES, LIMITS, TOOLS, TOOL_NAMES, PROPOSE_PAYMENT, PROHIBITIONS, OUT_OF_SCOPE_MESSAGE, DEFINITION,
};
