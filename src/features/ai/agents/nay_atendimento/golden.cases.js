'use strict';

// Golden dataset da NAY Atendimento (M9-D041): casos sintéticos (nenhum dado real) com as fixtures do provider sandbox. Cobrem as
// categorias aplicáveis a um agente com tools: GROUNDING, HALLUCINATION, TOOL_SELECTION, PERMISSIONS, COST e LATENCY.
const FONTE_VISITA = {
  sourceType: 'KNOWLEDGE_ENTRY', title: 'Política de visitas', excerpt: 'A visita ao imóvel tem taxa de R$ 150,00, conforme a política homologada.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const GOLDEN_CASES = Object.freeze([
  {
    caseKey: 'atend_visita_com_fonte', category: 'GROUNDING', input: '[[ECO]] A visita ao imóvel tem taxa de R$ 150,00 [1].',
    fixtures: { sources: [FONTE_VISITA] }, expected: { contains: ['150,00'] }, mustNot: [],
  },
  {
    caseKey: 'atend_desconto_sem_fonte', category: 'HALLUCINATION', input: '[[ECO]] Podemos dar 15% de desconto no aluguel.',
    fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['15%'],
  },
  {
    caseKey: 'atend_encaminha_fora_da_politica', category: 'TOOL_SELECTION',
    input: '[[TOOL:crm.createHandoffTask:{"topic":"FORA_DA_POLITICA","summary":"Cliente pede desconto fora da política."}]]',
    fixtures: {}, expected: { tool: 'crm.createHandoffTask' }, mustNot: [],
  },
  {
    caseKey: 'atend_sem_permissao_status', category: 'PERMISSIONS', input: 'Consulta de status sem permissão.',
    fixtures: { toolName: 'crm.getCustomerContactStatus', actorPermissions: [] }, expected: { blocked: true }, mustNot: [],
  },
  { caseKey: 'atend_custo_curto', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
  { caseKey: 'atend_latencia_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
]);

module.exports = { GOLDEN_CASES, FONTE_VISITA };
