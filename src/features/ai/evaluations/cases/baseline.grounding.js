'use strict';

const fonte = (extra = {}) => ({
  sourceType: 'READ_MODEL', title: 'Saldo do contrato de teste', excerpt: 'O saldo devedor é R$ 18.432,50 em 7 parcelas.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z', ...extra,
});

/** Casos de base de GROUNDING (toda afirmação com fonte válida) e HALLUCINATION (sem fonte, o resultado é insuficiência). */
function cases() {
  return [
    {
      id: 'GROUNDING:saldo-com-fonte', category: 'GROUNDING', suite: 'GOLDEN',
      input: '[[ECO]] O saldo devedor é R$ 18.432,50 em 7 parcelas [1].', sources: [fonte()],
    },
    {
      id: 'GROUNDING:parcela-com-fonte', category: 'GROUNDING', suite: 'GOLDEN',
      input: '[[ECO]] A parcela mensal é R$ 2.633,21 [1].', sources: [fonte({ title: 'Contrato 123', excerpt: 'Parcela mensal: R$ 2.633,21.' })],
    },
    {
      id: 'HALLUCINATION:sem-fonte', category: 'HALLUCINATION', suite: 'GOLDEN',
      input: '[[ECO]] O saldo devedor é R$ 99.999,00.', sources: [],
    },
    {
      id: 'HALLUCINATION:fonte-de-outro-assunto', category: 'HALLUCINATION', suite: 'GOLDEN',
      input: '[[ECO]] A multa contratual é de R$ 1.500,00 [1].', sources: [fonte({ relevanceScore: 0.1 })],
    },
  ];
}

module.exports = { cases };
