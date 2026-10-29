'use strict';

// Marco 9, M9-D214 (critério vindo da M9-D204) — o enqueuer REAL do Dispatch Service no outbox: evento com target_domain gera
// exatamente 1 linha de integration.dispatches, com outbox_event_id igual ao id do evento, dentro da transação do despacho.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sequelize, comTenant, carregarTenants, conexaoAtiva, limparPendentes, dispatch } = require('../_helpers/m9d214Env');
const { publishDomainEvent } = require('../../../src/engines/events/outbox');
const { dispatchPendingEventsForCompany } = require('../../../src/engines/events/outbox-dispatcher');
const gateway = require('../../../src/engines/events/dispatchGateway');
const { Group, Company } = require('../../../src/models');

let tenant;
let msg;

before(async () => {
  ({ tenant } = await carregarTenants());
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
// Independe da ordem da suíte: eventos PENDING deixados por outros testes (ex.: syncCursors) ocupariam o lote do despacho.
const esvaziarOutbox = () => comTenant(tenant, (t) => sequelize.query(
  `UPDATE integration.outbox_events SET status = 'DISPATCHED' WHERE company_id = :c AND status = 'PENDING'`, { replacements: { c: tenant.companyId }, transaction: t },
));
beforeEach(async () => { gateway.resetDispatchEnqueuer(); await limparPendentes(tenant); await esvaziarOutbox(); });
after(async () => { gateway.resetDispatchEnqueuer(); await sequelize.close(); });

async function publicar(over = {}) {
  return comTenant(tenant, (t) => publishDomainEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'Message', aggregateId: crypto.randomUUID(), eventType: 'sendText',
    payload: { to: '+5541999990009', text: 'Seu boleto vence amanhã' }, idempotencyKey: `qa-m9-d214:${crypto.randomUUID()}`, targetDomain: 'MESSAGING', connectionId: msg.id, ...over,
  }, t));
}

async function despachar() {
  const group = await Group.findByPk(tenant.groupId);
  const company = await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    return Company.findByPk(tenant.companyId, { transaction: t });
  });
  return dispatchPendingEventsForCompany(group, company, { limit: 50 });
}

const doEvento = (id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM integration.dispatches WHERE outbox_event_id = :id', { replacements: { id }, transaction: t }))[0]);

test('dispatch_outbox_enqueuer_real_gera_uma_linha_com_outbox_event_id', async () => {
  const antes = await publicar();
  const r0 = await despachar();
  assert.equal(r0.waiting >= 1, true, 'sem o Dispatch Service registrado o evento fica PENDING (nada se perde)');
  assert.equal((await doEvento(antes.id)).length, 0);

  dispatch.installOutboxEnqueuer();
  assert.equal(typeof gateway.getDispatchEnqueuer(), 'function', 'o enqueuer real está registrado');
  const r1 = await despachar();
  assert.ok(r1.published >= 1);
  const linhas = await doEvento(antes.id);
  assert.equal(linhas.length, 1, 'exatamente 1 linha por evento');
  assert.equal(linhas[0].outbox_event_id, antes.id);
  assert.equal(linhas[0].status, 'PENDING');
  assert.equal(linhas[0].operation, 'sendText');
  assert.equal(linhas[0].connection_id, msg.id);
  assert.equal(linhas[0].idempotency_key, antes.idempotencyKey, 'a chave do evento é a chave do dispatch');
  assert.equal(linhas[0].aggregate_type, 'Message');
  const [evento] = await comTenant(tenant, async (t) => (await sequelize.query('SELECT status FROM integration.outbox_events WHERE id = :id', { replacements: { id: antes.id }, transaction: t }))[0]);
  assert.notEqual(evento.status, 'PENDING', 'o evento foi publicado');
  // Despachar de novo não duplica.
  await despachar();
  assert.equal((await doEvento(antes.id)).length, 1);
});

test('dispatch_outbox_enqueuer_falha_desfaz_a_linha_e_o_evento_segue_pendente', async () => {
  dispatch.installOutboxEnqueuer();
  const ruim = await publicar({ eventType: 'operacaoInexistente' });
  await despachar();
  assert.equal((await doEvento(ruim.id)).length, 0, 'operação fora das capabilities não grava dispatch');
  const [e] = await comTenant(tenant, async (t) => (await sequelize.query('SELECT status, retry_count FROM integration.outbox_events WHERE id = :id', { replacements: { id: ruim.id }, transaction: t }))[0]);
  assert.ok(e.retry_count >= 1, 'a falha foi contada no evento (retry do outbox)');
});
