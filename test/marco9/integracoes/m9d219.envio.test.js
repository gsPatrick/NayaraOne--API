'use strict';

// Marco 9, M9-D219 — o envio grava o payload JÁ minimizado, o hash do minimizado e a finalidade (testes 4 e 6).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, ler, chave, dispatch } = require('../../integrations/dispatch/dispatchHelpers');
const { createMinimizedDispatch } = require('../../../src/features/integrations/minimization');
const { imovelCom40Campos } = require('../_helpers/intImovel');

let tenant;
let portal;
let banco;
let msg;
before(async () => {
  ({ tenant } = await carregarTenants());
  portal = await conexao(tenant, 'PORTAL');
  banco = await conexao(tenant, 'BANK');
  msg = await conexao(tenant, 'MESSAGING');
});
after(async () => { await sequelize.close(); });

const enviar = (con, operation, domainObject, extra = {}) => comTenant(tenant, (t) => createMinimizedDispatch(ctxDe(tenant), { connectionId: con.id, operation, idempotencyKey: chave(), domainObject, ...extra }, t));

test('minimizacao_snapshot_guarda_payload_minimizado', async () => {
  const imovel = imovelCom40Campos();
  const { dispatch: d, minimization } = await enviar(portal, 'publishListing', imovel);
  const linha = await ler(tenant, d.id);
  assert.equal(Object.keys(linha.payload_snapshot).length, 12);
  assert.ok(!JSON.stringify(linha.payload_snapshot).includes('CANARY'), 'o snapshot não tem valor interno');
  assert.equal(linha.payload_hash, dispatch.hashPayload(linha.payload_snapshot), 'o hash é do minimizado');
  assert.notEqual(linha.payload_hash, dispatch.hashPayload(imovel), 'e não do objeto completo');
  assert.equal(linha.fields_dropped, 28);
  assert.equal(minimization.fieldsDropped.length, 28);
  // Sem mapper declarado a operação não sai: o envio de dado de domínio passa sempre por um mapper.
  await assert.rejects(enviar(portal, 'getListingStatus_inexistente', imovel), (e) => e.code === 'INTEGRATION_MAPPER_MISSING');
  // O snapshot continua imutável no banco.
  await assert.rejects(comTenant(tenant, (t) => sequelize.query("UPDATE integration.dispatches SET payload_snapshot = '{}'::jsonb WHERE id = :id", { replacements: { id: d.id }, transaction: t })));
});

test('minimizacao_finalidade_gravada', async () => {
  const casos = [
    [portal, 'publishListing', imovelCom40Campos(), 'LISTING_PUBLICATION'],
    [banco, 'submitPayment', { amount: '10.00', beneficiary: { name: 'Fulano', document: '123' } }, 'PAYMENT'],
    [msg, 'sendText', { to: '+5541999990000', text: 'olá' }, 'CUSTOMER_MESSAGE'],
  ];
  for (const [con, op, obj, purpose] of casos) {
    const { dispatch: d } = await enviar(con, op, obj);
    assert.equal((await ler(tenant, d.id)).purpose, purpose, `${op} grava ${purpose}`);
  }
  // A finalidade é imutável como o conteúdo aprovado.
  const { dispatch: d } = await enviar(msg, 'sendText', { to: '+5541999990001', text: 'oi' });
  await assert.rejects(
    comTenant(tenant, (t) => sequelize.query("UPDATE integration.dispatches SET purpose = 'PAYMENT' WHERE id = :id", { replacements: { id: d.id }, transaction: t })),
    (e) => /INTEGRATION_DISPATCH_IMMUTABLE/.test(String(e.parent?.message || e.message))
  );
});

test('minimizacao_violacao_nao_grava_envio', async () => {
  const antes = await comTenant(tenant, (t) => sequelize.query('SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c', { replacements: { c: msg.id }, transaction: t }));
  await assert.rejects(
    enviar(msg, 'sendMedia', { to: '+5541999990000', mediaRef: 'doc', mediaClassification: 'RESTRICTED' }),
    (e) => e.statusCode === 422 && e.code === 'INTEGRATION_PAYLOAD_CLASSIFICATION_VIOLATION'
  );
  const depois = await comTenant(tenant, (t) => sequelize.query('SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c', { replacements: { c: msg.id }, transaction: t }));
  assert.equal(depois[0][0].n, antes[0][0].n, 'nada foi gravado');
  // Entidade interna no lugar do objeto de domínio: recusa 500.
  class Entidade { constructor() { this.dataValues = { a: 1 }; } toJSON() { return this.dataValues; } }
  await assert.rejects(enviar(portal, 'publishListing', new Entidade()), (e) => e.code === 'INTEGRATION_PAYLOAD_ENTITY_NOT_ALLOWED');
});

test('minimizacao_repetir_chave_devolve_o_mesmo_envio', async () => {
  const k = chave();
  const obj = { to: '+5541999990009', text: 'oi' };
  const a = await comTenant(tenant, (t) => createMinimizedDispatch(ctxDe(tenant), { connectionId: msg.id, operation: 'sendText', idempotencyKey: k, domainObject: obj }, t));
  const b = await comTenant(tenant, (t) => createMinimizedDispatch(ctxDe(tenant), { connectionId: msg.id, operation: 'sendText', idempotencyKey: k, domainObject: obj }, t));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.dispatch.id, b.dispatch.id);
});
