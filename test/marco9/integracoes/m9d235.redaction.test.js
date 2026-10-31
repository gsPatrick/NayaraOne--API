'use strict';

// Marco 9, M9-D235 (reabertura M5 da auditoria cega) — a detecção de dado pessoal do e-mail recebido mora na biblioteca única de
// redaction (src/shared/redaction): o pipeline não carrega regex nem algoritmo de cartão/CPF/CNPJ próprios.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzePii, hasPan } = require('../../../src/features/integrations/email/inbound/inbound.pii');
const redaction = require('../../../src/shared/redaction');

const PASTA = path.join(__dirname, '../../../src/features/integrations/email/inbound');

test('inbound_pii_usa_so_a_biblioteca_de_redaction', () => {
  assert.equal(hasPan, redaction.containsCardNumber, 'a decisão sobre cartão é a da biblioteca');
  for (const arquivo of fs.readdirSync(PASTA).filter((f) => f.endsWith('.js'))) {
    const fonte = fs.readFileSync(path.join(PASTA, arquivo), 'utf8');
    assert.doesNotMatch(fonte, /function\s+luhn|%\s*10\s*===?\s*0|\\d\{3\}\\\.\?\\d\{3\}|new RegExp\(\s*['"`]\\\\?b?\\\\d/i, `${arquivo} não pode ter detecção própria`);
    assert.doesNotMatch(fonte, /\/\\d\{(?:11|13|14|16)\}/, `${arquivo} não pode ter regex própria de documento ou cartão`);
  }
});

test('inbound_pii_comportamento_preservado_com_a_biblioteca', () => {
  const pan = analyzePii('pague com 4111 1111 1111 1111 hoje');
  assert.equal(pan.pan, true);
  assert.deepEqual(pan.types, ['CARD']);
  assert.doesNotMatch(pan.text, /4111/);
  const cpf = analyzePii('meu CPF 123.456.789-09');
  assert.equal(cpf.pan, false);
  assert.match(cpf.text, /\*\*\*\.456\.789-\*\*/);
  assert.equal(hasPan('CPF 123.456.789-09'), false, 'CPF válido não conta como cartão');
  assert.equal(hasPan('sem número nenhum'), false);
});
