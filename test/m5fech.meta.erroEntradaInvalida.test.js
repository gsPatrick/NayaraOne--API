'use strict';
/**
 * Pentest automatizado do Marco 5 (11/11/2026): texto maior que a coluna e objeto no lugar de identificador viravam 500.
 *
 * Integração dos Marcos 3 a 6 com o Marco 9 (13/11/2026): vale o contrato do tratador global do Marco 9 (DI-M9R-20/25). Erro de DADO do
 * banco (classe 22, ex.: 22001 texto longo) só vira 400 com PROVA de que o valor recusado veio do pedido (o campo do pedido com aquele
 * valor); sem a prova é defeito do servidor (500, registrado). Objeto no lugar de identificador é recusado ANTES, pelo esquema de cada
 * rota (a varredura de todas as rotas de escrita é test/entradaGlobal.rotas.test.js); o erro do Sequelize que chega ao tratador é do
 * código, não do pedido (500 com código de suporte). Teste de unidade do tratador, sem banco.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const errorHandler = require('../src/middlewares/errorHandler');

async function responder(err, body = {}) {
  let out = null;
  const res = { getHeader: () => null, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
  await errorHandler(err, { correlationId: 't', method: 'POST', originalUrl: '/x', body, query: {}, params: {} }, res, () => {});
  return out;
}

function textoLongo(valor) {
  return Object.assign(new Error('value too long for type character varying(16)'), {
    name: 'SequelizeDatabaseError',
    parent: { code: '22001', message: 'value too long for type character varying(16)' },
    sql: 'INSERT INTO "legal"."contracts" ("id","contract_number") VALUES ($1,$2)',
    parameters: ['id', valor],
  });
}

test('texto maior que a coluna VARCHAR (Postgres 22001) com o valor vindo do pedido responde 400 VALUE_TOO_LONG, não 500', async () => {
  const valor = 'X'.repeat(40);
  const r = await responder(textoLongo(valor), { contractNumber: valor });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALUE_TOO_LONG');
  assert.ok(!JSON.stringify(r.body).includes(valor), 'o texto não volta na resposta');
});

test('o mesmo 22001 sem o valor no pedido é defeito do servidor: 500 com código de suporte (Marco 9, DI-M9R-25)', async () => {
  const r = await responder(textoLongo('Y'.repeat(40)), { outroCampo: 'curto' });
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL_ERROR');
});

test('erro do Sequelize com objeto no lugar de identificador não vira 400 no tratador: a porta (esquema da rota) recusa antes', async () => {
  for (const msg of ['Invalid value { \'$gt\': \'\' }', 'Argument passed to findByPk is invalid: [object Object]', 'WHERE parameter "id" has invalid "undefined" value']) {
    const r = await responder(new Error(msg), { id: { $gt: '' } });
    assert.equal(r.status, 500, msg);
    assert.equal(r.body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(r.body).includes('$gt'), 'nada do pedido volta na resposta');
  }
});

test('erro sem relação com entrada continua 500 com código de suporte', async () => {
  const r = await responder(new Error('falha qualquer do servidor'));
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL_ERROR');
});
