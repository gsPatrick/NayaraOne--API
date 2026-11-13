'use strict';

// Livro do Marco 3 §16/§19 (CRM-TS-011) e Guia §12: validateGeneratedDescription(output, approvedFacts); §12: "Não inferir atributo sensível do
// cliente"; §15/§12: sentimento e ocorrência só como sugestão. Funções puras, sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateGeneratedDescription } = require('../src/features/ai/agents/nay_comercial/comercial.descriptionGuard');
const { onlyApprovedPublicFacts, buildPropertyPrompt } = require('../src/features/ai/agents/nay_comercial/comercial.publicFacts');
const { stripSensitive, sensitiveCategoriesOf } = require('../src/features/ai/agents/nay_comercial/comercial.sensitive');
const { termsOf } = require('../src/features/ai/agents/scope/scope.evaluate');
const { SENSITIVE_SETTING_DEFAULTS, CATEGORY_KEYS } = require('../src/features/ai/agents/nay_comercial/comercial.sensitive.settings');
const { CAP_SETTING_DEFAULTS, CAP_KEYS } = require('../src/features/ai/agents/nay_comercial/comercial.capabilities.settings');
const { classifyMessage } = require('../src/features/ai/agents/nay_comercial/comercial.messageSummary');

const ROW = {
  public_code: 'IMV-ABC', type: 'APARTMENT', purpose: 'VENDA', neighborhood: 'Batel', city: 'Curitiba', state: 'PR', area_total: 120, area_built: null,
  bedrooms: 3, bathrooms: null, parking_spots: 1, price_public: '750000.00', condo_fee_public: null, iptu_public: null, features_public: ['varanda'],
  description_public: 'Lindo apartamento com piscina', title: 'Apto do João',
};
const FACTS = onlyApprovedPublicFacts(ROW);
const TERMS = termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.descriptionTerms]);
const SENS = Object.fromEntries(CATEGORY_KEYS.map(([cat, key]) => [cat, termsOf(SENSITIVE_SETTING_DEFAULTS[key])]));

test('Guia §12 onlyApprovedPublicFacts: só os campos públicos preenchidos; texto livre (título, descrição pública) não é fato', () => {
  const keys = FACTS.map((f) => f.key);
  assert.deepEqual(keys, ['type', 'purpose', 'neighborhood', 'city', 'state', 'area_total', 'bedrooms', 'parking_spots', 'price_public', 'features_public']);
  assert.ok(!JSON.stringify(FACTS).includes('piscina'), 'a descrição pública antiga não vira fato');
  assert.equal(buildPropertyPrompt({ facts: FACTS }).instruction, 'Use somente os fatos fornecidos. Não invente metragem, acabamento, localização ou benefício.');
});

test('CRM-TS-011 AI hallucination: campo ausente, a descrição não inventa (validateGeneratedDescription recusa metragem, quantidade, valor e característica fora dos fatos)', () => {
  const ok = validateGeneratedDescription('Apartamento de 120 m² com 3 quartos e 1 vaga no Batel, Curitiba [1]. Tem varanda [1]. Preço R$ 750.000,00 [1].', FACTS, { controlledTerms: TERMS });
  assert.equal(ok.ok, true, JSON.stringify(ok.violations));
  const ruim = validateGeneratedDescription([
    'Apartamento de 120 m² no Batel [1].', 'São 135 metros quadrados de área útil [1].', 'Tem 2 suítes e 2 banheiros [1].', 'Conta com piscina e porcelanato [1].',
    'Fica próximo ao shopping [1].', 'Condomínio de R$ 900,00 [1].', 'Tem 4 quartos [1].',
  ].join(' '), FACTS, { controlledTerms: TERMS });
  assert.equal(ruim.ok, false);
  const kinds = ruim.violations.map((v) => v.kind);
  for (const k of ['METRAGEM_INVENTADA', 'CARACTERISTICA_AUSENTE', 'VALOR_INVENTADO', 'QUANTIDADE_INVENTADA']) assert.ok(kinds.includes(k), `${k} em ${kinds}`);
  assert.equal(ruim.text, 'Apartamento de 120 m² no Batel [1].', 'só a frase verdadeira fica');
  assert.ok(validateGeneratedDescription('Imóvel com 120,5 m² [1].', FACTS).violations.length === 1, 'metragem diferente por meio metro também é inventada');
});

test('CAD-12 Não inferir atributo sensível do cliente: as oito categorias da LGPD saem do texto, o resto fica', () => {
  const casos = {
    racial: 'O cliente é afrodescendente.', religion: 'Ele parece ser católico.', politics: 'É eleitor do partido X.', union: 'É sindicalizado.',
    health: 'Ela está grávida.', sexual: 'O cliente é homossexual.', genetic: 'Fez exame de DNA.', biometric: 'Mandou a impressão digital.',
  };
  for (const [cat, frase] of Object.entries(casos)) {
    assert.deepEqual(sensitiveCategoriesOf(frase, SENS), [cat], frase);
    const out = stripSensitive(`Quer apartamento de 3 quartos. ${frase}`, SENS);
    assert.equal(out.changed, true);
    assert.match(out.text, /^Quer apartamento de 3 quartos\. Removi um trecho que tratava de dado pessoal sensível/);
    assert.ok(!out.text.includes(frase));
  }
  assert.equal(stripSensitive('Quer visitar no sábado.', SENS).changed, false);
});

test('CAD-12 sentimento e ocorrência sugerida pelas palavras (parâmetros), só como indício', () => {
  const terms = {
    CONFLICT: termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.termsConflict]), POOR_SERVICE: termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.termsPoorService]),
    COMPLAINT: termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.termsComplaint]), PENDING_RETURN: termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.termsPendingReturn]),
    COMPLIMENT: termsOf(CAP_SETTING_DEFAULTS[CAP_KEYS.termsCompliment]),
  };
  assert.deepEqual(classifyMessage('Vou procurar o Procon, quero meu dinheiro.', terms).occurrenceType, 'CONFLICT');
  assert.equal(classifyMessage('Parabéns pelo atendimento, excelente!', terms).sentiment, 'POSITIVO');
  assert.deepEqual(classifyMessage('Bom dia, tudo certo para sábado.', terms), { sentiment: 'NEUTRO', occurrenceType: null, matched: [] });
  assert.equal(classifyMessage('Aguardo retorno sobre a proposta.', terms).occurrenceType, 'PENDING_RETURN');
});
