'use strict';

// M9-D407 (rodada 5, L-4) — CNPJ e número de decreto/lei/processo são identificação de documento, não afirmação sobre o imóvel: o validador factual os aceita; as palavras que
// identificam o documento vêm do parâmetro marketing.factual.referencias_legais. Número solto continua inexplicável (UNKNOWN_CLAIM). Função pura, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAgainstFacts } = require('../../../src/features/marketing/content/factualValidator');
const { FACTUAL_SETTING_DEFAULTS, FACTUAL_SETTINGS_SCHEMA, LEGAL_REFS_KEY, parseTerms } = require('../../../src/features/marketing/content/factual/settings');
const { FACTS, first } = require('../_helpers/mktFactual');

const v = (text, options) => validateAgainstFacts(text, FACTS, options);

test('cnpj_e_decreto_nao_reprovam_o_texto (L-4)', () => {
  for (const text of ['Nayara Ltda, CNPJ 12.345.678/0001-90.', 'Casa de 3 quartos. Decreto 10.123/19.', 'Conforme a Lei nº 8.245/91, casa de 3 quartos.', 'Processo 12.345.678/9 e CRECI 12345.', 'Inscrição 123.456.7890/001', 'Empresa 12.345.678/0001-90']) {
    assert.deepEqual(v(text), { ok: true, findings: [] }, text);
  }
});

test('numero_solto_continua_inexplicavel_e_documento_de_pessoa_nao_vale', () => {
  assert.equal(first(v('Casa a 12 minutos do metrô.'), 'UNKNOWN_CLAIM').kind, 'UNKNOWN_CLAIM');
  assert.equal(first(v('Fale com Ana, CPF 123.456.789-09.'), 'UNKNOWN_CLAIM').kind, 'UNKNOWN_CLAIM');
  assert.equal(first(v('Lance de 99 mil e Decreto 10.123/19.'), 'UNKNOWN_CLAIM') !== undefined || v('Lance de 99 mil e Decreto 10.123/19.').ok === false, true, 'o decreto não esconde o outro número');
});

test('as_palavras_vem_do_parametro_e_a_lista_vazia_deixa_o_numero_valer_como_afirmacao', () => {
  assert.ok(FACTUAL_SETTING_DEFAULTS[LEGAL_REFS_KEY].includes('decreto'));
  assert.equal(v('Portaria 77/20.', { referenciasLegais: parseTerms('decreto') }).ok, false, 'palavra fora da lista: o número é conferido');
  assert.equal(v('Portaria 77/20.', { referenciasLegais: parseTerms('decreto, portaria') }).ok, true, 'o administrador acrescenta palavras');
  const schema = FACTUAL_SETTINGS_SCHEMA[LEGAL_REFS_KEY];
  assert.equal(schema.type, 'string');
  assert.throws(() => schema.validate(LEGAL_REFS_KEY, '  ,  '), (e) => e.statusCode === 400);
  assert.doesNotThrow(() => schema.validate(LEGAL_REFS_KEY, 'decreto, lei'));
});
