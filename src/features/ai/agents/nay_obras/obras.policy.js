'use strict';

/**
 * M9-D037 — NAY Obras: o cadastro do agente (versão 1 do sistema, DRAFT e desabilitado). É a MESMA configuração que a migration
 * 748 grava em ai.agents/ai.agent_tools (uma migration não importa código de aplicação; o teste m9d037 confere a paridade).
 * Somente leitura: nenhuma tool de escrita (livro: "progresso, custos, diário, qualidade e pós-obra").
 */
const CODE = 'NAY_OBRAS';
const CRITICALITY = 'NON_CRITICAL';
const PURPOSE = 'Acompanhar o progresso físico e financeiro das obras, os custos, o diário de obra, a qualidade e o pós-obra, apontando atrasos e desvios com fontes.';
const SYSTEM_POLICY = [
  'Você é a NAY Obras. Responda só sobre obras: progresso, custos (orçado x realizado), diário de obra, qualidade (não conformidades) e pós-obra (garantias).',
  'Use somente as ferramentas de leitura permitidas e cite a fonte de cada número. Valores e prazos vêm das ferramentas; nunca calcule nem invente.',
  'Você é somente leitura. Nunca altere medição, aprove pagamento a empreiteiro, altere cronograma ou orçamento nem encerre garantia: essas decisões são de pessoas autorizadas.',
  'Uma ação sugerida aparece apenas como texto na resposta; você não cria recomendação, proposta nem tarefa.',
].join('\n');
const MODEL_POLICY = Object.freeze({ maxOutputTokens: 1024 });
const DATA_SCOPES = Object.freeze(['construction.projects', 'construction.daily_reports', 'construction.budget_lines', 'construction.maintenance_cases']);
const LIMITS = Object.freeze({ max_tool_calls_por_run: 6 });

const TOOL_NAMES = Object.freeze([
  'construction.getProjectProgress', 'construction.getBudgetVsActual', 'construction.getDailyReports',
  'construction.getQualityNonConformities', 'construction.getWarrantyCases', 'knowledge.search',
]);
/** Allowlist como linhas de ai.agent_tools (permissão e risco são os das definições registradas). */
const TOOLS = Object.freeze(TOOL_NAMES.map((toolName) => Object.freeze({
  toolName, permissionCode: toolName === 'knowledge.search' ? 'ai:use' : 'construction:read', riskLevel: 'LOW', requiresHumanApproval: false, enabled: true,
})));

/** As quatro proibições do livro: código, o que é e a recusa devolvida. */
const PROHIBITIONS = Object.freeze([
  { code: 'ALTERAR_MEDICAO', label: 'alterar medição', message: 'Não posso alterar medição: a NAY Obras só consulta. A medição é decidida por quem tem essa alçada.' },
  { code: 'APROVAR_PAGAMENTO_EMPREITEIRO', label: 'aprovar pagamento a empreiteiro', message: 'Não posso aprovar pagamento a empreiteiro: a NAY Obras só consulta. A aprovação é de uma pessoa autorizada.' },
  { code: 'ALTERAR_CRONOGRAMA_ORCAMENTO', label: 'alterar cronograma ou orçamento', message: 'Não posso alterar cronograma nem orçamento: a NAY Obras só consulta. A alteração é de uma pessoa autorizada.' },
  { code: 'ENCERRAR_GARANTIA', label: 'encerrar garantia', message: 'Não posso encerrar garantia: a NAY Obras só consulta. O encerramento é de uma pessoa autorizada.' },
]);

const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

module.exports = {
  CODE, CRITICALITY, PURPOSE, SYSTEM_POLICY, MODEL_POLICY, DATA_SCOPES, LIMITS, TOOL_NAMES, TOOLS, PROHIBITIONS, OUT_OF_SCOPE_MESSAGE,
};
