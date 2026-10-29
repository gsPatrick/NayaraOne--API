'use strict';

/**
 * M9-D035 — NAY Diretoria: o cadastro do agente (versão 1 do sistema, DRAFT e desabilitado). É o conteúdo que o seed do sistema
 * (scripts/ai/seedSystemAgents.js, agents/kit) grava em ai.agents/ai.agent_tools e que a empresa recebe por provisionAgentVersion.
 * Somente leitura e só agregados: o livro limita o agente a "saúde da empresa, riscos, prioridades e explicações".
 */
const CODE = 'NAY_DIRETORIA';
const CRITICALITY = 'NON_CRITICAL';
const PURPOSE = 'Resumir a saúde da empresa, listar riscos e prioridades e explicar indicadores, sempre com as fontes dos read models das outras áreas; não executa nada.';
const SYSTEM_POLICY = [
  'Você é a NAY Diretoria. Responda só sobre a saúde da empresa, riscos, prioridades e explicação de indicadores, com totais e faixas.',
  'Use somente as ferramentas de leitura permitidas e cite a fonte de cada número. Números vêm das ferramentas (read models); nunca calcule, estime nem invente.',
  'Você é somente leitura. Nunca execute nem proponha ação operacional: prioridades sugeridas aparecem apenas como texto na resposta.',
  'Responda só com agregados. Nunca liste clientes, contratos ou casos pelo nome nem valores individuais.',
  'Área em que a pessoa não tem acesso entra no resumo como "<Área>: sem acesso", sem detalhe.',
].join('\n');
const MODEL_POLICY = Object.freeze({ maxOutputTokens: 1024 });
const DATA_SCOPES = Object.freeze(['finance.summary', 'crm.summary', 'construction.summary', 'legal.summary', 'correspondent.summary', 'inventory.summary']);
const LIMITS = Object.freeze({ max_tool_calls_por_run: 8 });

const TOOL_NAMES = Object.freeze([
  'finance.getWeeklyHealth', 'crm.getPipelineSummary', 'construction.getPortfolioProgress', 'legal.getExpiringContracts',
  'correspondent.getStalledCases', 'inventory.getStockRisks', 'knowledge.search', 'memory.recall',
]);
const PERMISSION_OF = Object.freeze({
  'finance.getWeeklyHealth': 'finance:read', 'crm.getPipelineSummary': 'crm:opportunities:read', 'construction.getPortfolioProgress': 'construction:read',
  'legal.getExpiringContracts': 'legal:read', 'correspondent.getStalledCases': 'correspondent:read', 'inventory.getStockRisks': 'inventory:read',
  'knowledge.search': 'ai:use', 'memory.recall': 'ai:use',
});
/** Allowlist como linhas de ai.agent_tools: todas de leitura e risco LOW. */
const TOOLS = Object.freeze(TOOL_NAMES.map((toolName) => Object.freeze({
  toolName, permissionCode: PERMISSION_OF[toolName], riskLevel: 'LOW', requiresHumanApproval: false, enabled: true,
})));

/** Área de cada tool de leitura de área: rótulo da resposta ("Financeiro: sem acesso"), permissão e tema usado pelo orquestrador. */
const AREAS = Object.freeze([
  { topic: 'finance', label: 'Financeiro', tool: 'finance.getWeeklyHealth' },
  { topic: 'crm', label: 'Comercial', tool: 'crm.getPipelineSummary' },
  { topic: 'construction', label: 'Obras', tool: 'construction.getPortfolioProgress' },
  { topic: 'legal', label: 'Jurídico', tool: 'legal.getExpiringContracts' },
  { topic: 'correspondent', label: 'Correspondente', tool: 'correspondent.getStalledCases' },
  { topic: 'inventory', label: 'Estoque', tool: 'inventory.getStockRisks' },
]);

/** As três proibições do agente: código, o que é e a recusa devolvida (a lista de termos de cada uma é parâmetro da empresa). */
const PROHIBITIONS = Object.freeze([
  { code: 'EXECUTAR_OU_PROPOR_ACAO', label: 'executar ou propor ação operacional', message: 'A NAY Diretoria não executa nem propõe ações operacionais: ela só resume, aponta riscos e prioridades em texto. A ação deve ser feita por quem tem a alçada, na área responsável.' },
  { code: 'DETALHE_NOMINAL', label: 'detalhar clientes, contratos ou casos', message: 'A NAY Diretoria responde só com totais e faixas, sem lista nominal de clientes, contratos ou casos nem valores individuais. Para o detalhe, consulte a área responsável com a sua permissão.' },
  { code: 'NUMERO_SEM_FONTE', label: 'emitir número que não vem de read model', message: 'Só informo números calculados pelo sistema, com a fonte. Não faço estimativas nem chutes de valores.' },
]);

/** O que `provisionAgentVersion` grava na empresa e `applySystemDefinition` no padrão do sistema (agents/kit). */
const DEFINITION = Object.freeze({
  code: CODE, purpose: PURPOSE, systemPolicy: SYSTEM_POLICY, modelPolicy: MODEL_POLICY, dataScopes: DATA_SCOPES, limits: LIMITS, criticality: CRITICALITY, tools: TOOLS,
});

const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

module.exports = {
  CODE, CRITICALITY, PURPOSE, SYSTEM_POLICY, MODEL_POLICY, DATA_SCOPES, LIMITS, TOOL_NAMES, TOOLS, AREAS, PROHIBITIONS, OUT_OF_SCOPE_MESSAGE, DEFINITION,
};
