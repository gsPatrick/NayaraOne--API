'use strict';

/**
 * M9-D033 — golden dataset padrão do sistema: casos sintéticos (nenhum dado real) para cada um dos oito agentes do livro.
 * Os agentes do sistema nascem sem ferramenta (as ferramentas entram em M9-D034 a M9-D041), por isso as categorias
 * aplicáveis hoje são GROUNDING, HALLUCINATION, COST e LATENCY; os casos de TOOL_SELECTION e PERMISSIONS de cada agente
 * entram junto com as suas ferramentas. As entradas usam as fixtures do provider de testes (`[[ECO]]`).
 */
const AGENTES = [
  'NAY_DIRETORIA', 'NAY_COMERCIAL', 'NAY_FINANCEIRA', 'NAY_OBRAS', 'NAY_JURIDICA', 'NAY_CORRESPONDENTE', 'NAY_DOCUMENTAL', 'NAY_ATENDIMENTO',
];

const FONTE = {
  sourceType: 'READ_MODEL', title: 'Saldo do contrato de teste', excerpt: 'O saldo devedor é R$ 18.432,50 em 7 parcelas.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

const CASOS = [
  {
    caseKey: 'grounding_saldo_com_fonte', category: 'GROUNDING', input: '[[ECO]] O saldo devedor é R$ 18.432,50 em 7 parcelas [1].',
    fixtures: { sources: [FONTE] }, expected: { contains: ['18.432,50'] }, mustNot: [],
  },
  {
    caseKey: 'hallucination_sem_fonte', category: 'HALLUCINATION', input: '[[ECO]] O saldo devedor é R$ 99.999,00.',
    fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['99.999,00'],
  },
  {
    caseKey: 'cost_consulta_curta', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [],
  },
  {
    caseKey: 'latency_consulta_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [],
  },
];

const linhasDoSeed = () => AGENTES.flatMap((agentCode) => CASOS.map((c) => ({ agentCode, ...c })));

module.exports = { AGENTES, CASOS, linhasDoSeed };
