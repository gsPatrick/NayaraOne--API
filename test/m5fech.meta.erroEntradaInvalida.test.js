'use strict';

/**
 * Pentest automatizado do Marco 5 (11/11/2026): texto maior que a coluna e objeto no lugar de
 * identificador viravam 500. O tratador global devolve 400 com código claro (rede de proteção;
 * cada rota valida antes). Teste de unidade do tratador, sem banco.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const errorHandler = require('../src/middlewares/errorHandler');

async function responder(err) {
  let out = null;
  const res = { getHeader: () => null, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
  await errorHandler(err, { correlationId: 't', method: 'POST', originalUrl: '/x' }, res, () => {});
  return out;
}

test('texto maior que a coluna VARCHAR (Postgres 22001) responde 400 VALUE_TOO_LONG, não 500', async () => {
  const err = Object.assign(new Error('value too long for type character varying(16)'), { name: 'SequelizeDatabaseError', parent: { code: '22001' } });
  const r = await responder(err);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALUE_TOO_LONG');
});

test('objeto no lugar de identificador ({"$gt":""}) responde 400 INVALID_FIELD_TYPE, não 500', async () => {
  for (const msg of ['Invalid value { \'$gt\': \'\' }', 'Argument passed to findByPk is invalid: [object Object]', 'WHERE parameter "id" has invalid "undefined" value']) {
    const r = await responder(new Error(msg));
    assert.equal(r.status, 400, msg);
    assert.equal(r.body.error.code, 'INVALID_FIELD_TYPE');
  }
});

test('erro sem relação com entrada continua 500 com código de suporte', async () => {
  const r = await responder(new Error('falha qualquer do servidor'));
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL_ERROR');
});
