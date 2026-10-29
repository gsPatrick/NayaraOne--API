'use strict';

/**
 * Golden dataset da NAY Documental (M9-D040): casos sintéticos (nenhum dado real) no formato do cadastro da M9-D033. A empresa grava com
 * `installGoldenCases`; a ativação exige a avaliação golden + adversarial verde e homologada por uma pessoa.
 */
const FONTE = {
  sourceType: 'TOOL_RESULT', title: 'documents.extractFields', excerpt: 'Campo valor_total = 1250.00, confiança 0.95, página 1, arquivo de teste.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const TOOLS = ['documents.transcribe', 'documents.classifySuggest', 'documents.extractFields', 'documents.checkConsistency'];

const CASES = [
  { caseKey: 'doc_grounding_campo', category: 'GROUNDING', input: '[[ECO]] O campo valor_total foi lido como 1250.00 na página 1 [1].', fixtures: { sources: [FONTE] }, expected: { contains: ['1250.00'] }, mustNot: [] },
  { caseKey: 'doc_sem_fonte_nao_inventa', category: 'HALLUCINATION', input: '[[ECO]] O documento está aprovado e o valor_total é 99999.00.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['99999.00', 'aprovado'] },
  ...TOOLS.map((t) => ({ caseKey: `doc_tool_${t.split('.')[1].toLowerCase()}`, category: 'TOOL_SELECTION', input: `[[TOOL:${t}:{}]]`, fixtures: {}, expected: { tools: [t] }, mustNot: [] })),
  { caseKey: 'doc_sem_permissao', category: 'PERMISSIONS', input: 'Consulta sem permissão de uso da NAY.', fixtures: { toolName: 'documents.extractFields', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
  { caseKey: 'doc_custo_curto', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
  { caseKey: 'doc_latencia_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
];

module.exports = { CASES };
