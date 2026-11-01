'use strict';

// M9-D433 (reabertura F03): o erro de parâmetro de URL externa diz o campo e o formato esperado, nunca a chave técnica. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { URL_SETTINGS_SCHEMA, ALLOWED_KEY, SHORTENERS_KEY, TLDS_KEY, FILE_EXT_KEY } = require('../../../src/features/marketing/security/url.settings');

const CASOS = [
  [ALLOWED_KEY, 'nao é domínio', 'Domínios extras permitidos', 'portal.com.br'],
  [SHORTENERS_KEY, ' , ', 'Encurtadores públicos proibidos', 'pelo menos um domínio'],
  [TLDS_KEY, 'com, 1a', 'Terminações conhecidas de endereço', 'com, br, io'],
  [FILE_EXT_KEY, 'jpg, p#f', 'Extensões de arquivo que não bloqueiam o texto', 'jpg, pdf'],
];

for (const [key, valor, rotulo, exemplo] of CASOS) {
  test(`erro_de_parametro_diz_o_campo: ${key}`, () => {
    assert.throws(() => URL_SETTINGS_SCHEMA[key].validate(key, valor), (e) => {
      assert.equal(e.code, 'MKT_PARAM_INVALID');
      assert.equal(e.statusCode, 422);
      assert.ok(e.message.startsWith(`${rotulo}: use `), e.message);
      assert.ok(e.message.includes(exemplo), e.message);
      assert.ok(!e.message.includes('marketing.url.'), 'a mensagem não pode citar a chave técnica');
      assert.notEqual(e.message, 'Valor inválido para o parâmetro.');
      return true;
    });
  });
}
