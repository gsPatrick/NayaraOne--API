'use strict';

// Apoio dos testes do validador factual (M9-D407): fatos de um imóvel de referência e atalhos para ler os findings. Não é teste.

/** PublicPropertyReadModel de referência: política de endereço SO_BAIRRO (sem logradouro nem número). */
const FACTS = Object.freeze({
  publicId: 'IMV-0001',
  tipo: 'Casa',
  bairro: 'Pituba',
  cidade: 'Salvador',
  uf: 'BA',
  quartos: 3,
  suites: 1,
  banheiros: 2,
  vagas: 2,
  areaUtilM2: 120,
  areaTotalM2: 200,
  precoVenda: 780000,
  features: ['piscina', 'churrasqueira', 'varanda'],
});

const withFacts = (extra) => ({ ...FACTS, ...extra });
const withoutFacts = (...keys) => Object.fromEntries(Object.entries(FACTS).filter(([k]) => !keys.includes(k)));
const kinds = (result) => result.findings.map((f) => f.kind).sort();
const first = (result, kind) => result.findings.find((f) => f.kind === kind);

module.exports = { FACTS, withFacts, withoutFacts, kinds, first };
