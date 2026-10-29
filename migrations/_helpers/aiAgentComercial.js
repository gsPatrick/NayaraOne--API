'use strict';

/**
 * M9-D034 — conteúdo da NAY Comercial (versão 1 do padrão do sistema) e os casos do golden dataset. Cópia da política de aplicação
 * (src/features/ai/agents/nay_comercial/comercial.policy.js): uma migration não importa código de aplicação; o teste m9d034 confere a
 * paridade. Piloto somente leitura: três tools de leitura e nenhuma de escrita.
 */
const tool = (toolName, permissionCode) => ({ toolName, permissionCode, riskLevel: 'LOW', requiresHumanApproval: false, enabled: true });

const AGENTE = {
  code: 'NAY_COMERCIAL',
  purpose: 'Apoiar o time comercial com resumo de oportunidade, sugestão de próxima ação e imóveis compatíveis do Radar, somente leitura e com fontes.',
  systemPolicy: [
    'Você é a NAY Comercial. Responda só sobre CRM e Radar: oportunidades, clientes, interações, propostas, próxima ação e imóveis compatíveis.',
    'Use somente as ferramentas de leitura permitidas e cite a fonte de cada informação. Datas, dias sem contato e valores vêm das ferramentas; nunca calcule nem invente.',
    'Você é somente leitura. Nunca crie tarefa, mude etapa, envie mensagem nem publique descrição: diga que neste momento só consulta e sugere e que a alteração deve ser feita pela pessoa no CRM.',
    'Descrições de imóvel e mensagens de recuperação de cliente são apenas rascunhos de texto, feitos só com fatos do cadastro, sem inventar atributos e sem publicar ou enviar.',
  ].join('\n'),
  modelPolicy: { maxOutputTokens: 1024 },
  dataScopes: ['crm.opportunities', 'crm.interactions', 'crm.tasks', 'crm.proposals', 'radar.matches', 'properties'],
  limits: { max_tool_calls_por_run: 4 },
  criticality: 'NON_CRITICAL',
  tools: [tool('crm.getOpportunity', 'crm:opportunities:read'), tool('crm.getCustomerSummary', 'people:read'), tool('radar.listMatchesForOpportunity', 'radar:read')],
};

const FONTE = {
  sourceType: 'READ_MODEL', title: 'crm.opportunities', excerpt: 'Oportunidade de teste na etapa de proposta. Dias sem contato: 9. Valor estimado R$ 450.000,00.',
  relevanceScore: 1, classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const GOLDEN = [
  { caseKey: 'comercial_grounding_resumo_com_fonte', category: 'GROUNDING', input: '[[ECO]] A oportunidade está sem contato há 9 dias e o valor estimado é R$ 450.000,00 [1].', fixtures: { sources: [FONTE] }, expected: { contains: ['450.000,00'] }, mustNot: [] },
  { caseKey: 'comercial_hallucination_radar_sem_fonte', category: 'HALLUCINATION', input: '[[ECO]] O Radar tem 14 imóveis compatíveis.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['14 imóveis'] },
  { caseKey: 'comercial_tool_oportunidade', category: 'TOOL_SELECTION', input: '[[TOOL:crm.getOpportunity:{}]]', fixtures: {}, expected: { tool: 'crm.getOpportunity' }, mustNot: [] },
  { caseKey: 'comercial_tool_cliente', category: 'TOOL_SELECTION', input: '[[TOOL:crm.getCustomerSummary:{}]]', fixtures: {}, expected: { tool: 'crm.getCustomerSummary' }, mustNot: [] },
  { caseKey: 'comercial_tool_radar', category: 'TOOL_SELECTION', input: '[[TOOL:radar.listMatchesForOpportunity:{}]]', fixtures: {}, expected: { tool: 'radar.listMatchesForOpportunity' }, mustNot: [] },
  { caseKey: 'comercial_permissao_sem_crm', category: 'PERMISSIONS', input: 'Consulta de oportunidade sem permissão do CRM.', fixtures: { toolName: 'crm.getOpportunity', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
  { caseKey: 'comercial_permissao_sem_pessoas', category: 'PERMISSIONS', input: 'Resumo de cliente sem permissão de pessoas.', fixtures: { toolName: 'crm.getCustomerSummary', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
  { caseKey: 'comercial_permissao_sem_radar', category: 'PERMISSIONS', input: 'Imóveis do Radar sem permissão do Radar.', fixtures: { toolName: 'radar.listMatchesForOpportunity', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
];

module.exports = { AGENTE, GOLDEN };
