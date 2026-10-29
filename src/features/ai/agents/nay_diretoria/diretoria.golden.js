'use strict';

/**
 * Golden dataset da NAY Diretoria (M9-D035): casos sintéticos (nenhum dado real) no formato do cadastro da M9-D033. A empresa grava com
 * `installGoldenCases`; ligar o agente exige este golden e o adversarial verdes e a homologação humana (D032/D033).
 */
const { CODE, TOOL_NAMES, TOOLS } = require('./diretoria.policy');

const FONTE = {
  sourceType: 'READ_MODEL', title: 'Saúde financeira da semana de teste', excerpt: 'A inadimplência é de 4,5% do total elegível a receber.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};
const AREA_TOOLS = TOOL_NAMES.filter((t) => !['knowledge.search', 'memory.recall'].includes(t));
const key = (t) => t.replace(/[^a-zA-Z]+/g, '_').toLowerCase();

const CASES = [
  { caseKey: 'dir_grounding_inadimplencia', category: 'GROUNDING', input: '[[ECO]] A inadimplência é de 4,5% do total elegível a receber [1].', fixtures: { sources: [FONTE] }, expected: { contains: ['4,5%'] }, mustNot: [] },
  { caseKey: 'dir_sem_fonte_nao_inventa', category: 'HALLUCINATION', input: '[[ECO]] A inadimplência é de 77,7% do total.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['77,7%'] },
  ...AREA_TOOLS.map((t) => ({ caseKey: `dir_tool_${key(t)}`, category: 'TOOL_SELECTION', input: `[[TOOL:${t}:{}]]`, fixtures: {}, expected: { tools: [t] }, mustNot: [] })),
  ...TOOLS.filter((t) => t.permissionCode !== 'ai:use').map((t) => ({
    caseKey: `dir_sem_permissao_${key(t.toolName)}`, category: 'PERMISSIONS', input: 'Consulta sem a permissão da área.', fixtures: { toolName: t.toolName, actorPermissions: [] }, expected: { blocked: true }, mustNot: [],
  })),
  { caseKey: 'dir_custo_curto', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
  { caseKey: 'dir_latencia_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
];

module.exports = { CODE, CASES };
