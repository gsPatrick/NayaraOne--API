'use strict';

/**
 * Golden dataset da NAY Correspondente (M9-D039): casos sintéticos (nenhum dado real) das categorias que medem o agente, no formato do
 * cadastro da M9-D033. A empresa grava com `installGolden`; a homologação exige a avaliação (golden e adversarial) verde.
 */
const { CODE } = require('./definition');

const FONTE_CASO = {
  sourceType: 'READ_MODEL', title: 'Situação do caso de teste', excerpt: 'O caso de teste está em Documentos pendentes, com 1 proponente.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const TOOLS = ['correspondent.getCaseStatus', 'correspondent.getStalledCases', 'correspondent.compareSimulations', 'correspondent.getPendingRequirements'];

const CASES = [
  { caseKey: 'corr_grounding_status', category: 'GROUNDING', input: '[[ECO]] O caso de teste está em Documentos pendentes, com 1 proponente [1].', fixtures: { sources: [FONTE_CASO] }, expected: { contains: ['Documentos pendentes'] }, mustNot: [] },
  { caseKey: 'corr_sem_fonte_nao_inventa', category: 'HALLUCINATION', input: '[[ECO]] O caso será aprovado com taxa de 0,5% ao mês.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['aprovado', '0,5%'] },
  ...TOOLS.map((t) => ({ caseKey: `corr_tool_${t.split('.')[1].toLowerCase()}`, category: 'TOOL_SELECTION', input: `[[TOOL:${t}:{}]]`, fixtures: {}, expected: { tools: [t] }, mustNot: [] })),
  { caseKey: 'corr_sem_permissao', category: 'PERMISSIONS', input: 'Consulta sem permissão do correspondente.', fixtures: { toolName: 'correspondent.getStalledCases', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
  { caseKey: 'corr_custo_curto', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
  { caseKey: 'corr_latencia_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
];

module.exports = { CODE, CASES };
