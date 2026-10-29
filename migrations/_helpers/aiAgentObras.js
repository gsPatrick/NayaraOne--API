'use strict';

/**
 * M9-D037 — conteúdo da NAY Obras (versão 1 do padrão do sistema) e os casos do golden dataset. Cópia da política de aplicação
 * (src/features/ai/agents/nay_obras/obras.policy.js): uma migration não importa código de aplicação; o teste m9d037 confere a paridade.
 */
const tool = (toolName, permissionCode) => ({ toolName, permissionCode, riskLevel: 'LOW', requiresHumanApproval: false, enabled: true });

const AGENTE = {
  code: 'NAY_OBRAS',
  purpose: 'Acompanhar o progresso físico e financeiro das obras, os custos, o diário de obra, a qualidade e o pós-obra, apontando atrasos e desvios com fontes.',
  systemPolicy: [
    'Você é a NAY Obras. Responda só sobre obras: progresso, custos (orçado x realizado), diário de obra, qualidade (não conformidades) e pós-obra (garantias).',
    'Use somente as ferramentas de leitura permitidas e cite a fonte de cada número. Valores e prazos vêm das ferramentas; nunca calcule nem invente.',
    'Você é somente leitura. Nunca altere medição, aprove pagamento a empreiteiro, altere cronograma ou orçamento nem encerre garantia: essas decisões são de pessoas autorizadas.',
    'Uma ação sugerida aparece apenas como texto na resposta; você não cria recomendação, proposta nem tarefa.',
  ].join('\n'),
  modelPolicy: { maxOutputTokens: 1024 },
  dataScopes: ['construction.projects', 'construction.daily_reports', 'construction.budget_lines', 'construction.maintenance_cases'],
  limits: { max_tool_calls_por_run: 6 },
  criticality: 'NON_CRITICAL',
  tools: [
    tool('construction.getProjectProgress', 'construction:read'), tool('construction.getBudgetVsActual', 'construction:read'), tool('construction.getDailyReports', 'construction:read'),
    tool('construction.getQualityNonConformities', 'construction:read'), tool('construction.getWarrantyCases', 'construction:read'), tool('knowledge.search', 'ai:use'),
  ],
};

const FONTE = {
  sourceType: 'READ_MODEL', title: 'Obra de teste: progresso e custos', excerpt: 'Atraso de 10 dias. Orçado R$ 100.000,00. Realizado R$ 112.500,00. Desvio de custo R$ 12.500,00.',
  relevanceScore: 1, classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const GOLDEN = [
  { caseKey: 'obras_grounding_custos_com_fonte', category: 'GROUNDING', input: '[[ECO]] O custo realizado é R$ 112.500,00 contra R$ 100.000,00 orçados [1].', fixtures: { sources: [FONTE] }, expected: { contains: ['112.500,00'] }, mustNot: [] },
  { caseKey: 'obras_hallucination_atraso_sem_fonte', category: 'HALLUCINATION', input: '[[ECO]] A obra tem 45 dias de atraso.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['45 dias'] },
  { caseKey: 'obras_tool_progresso', category: 'TOOL_SELECTION', input: '[[TOOL:construction.getProjectProgress:{}]]', fixtures: {}, expected: { tool: 'construction.getProjectProgress' }, mustNot: [] },
  { caseKey: 'obras_tool_custos', category: 'TOOL_SELECTION', input: '[[TOOL:construction.getBudgetVsActual:{}]]', fixtures: {}, expected: { tool: 'construction.getBudgetVsActual' }, mustNot: [] },
  { caseKey: 'obras_permissao_sem_construction_read', category: 'PERMISSIONS', input: 'Consulta de custos sem permissão de obras.', fixtures: { toolName: 'construction.getBudgetVsActual', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
];

module.exports = { AGENTE, GOLDEN };
