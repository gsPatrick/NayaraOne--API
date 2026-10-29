'use strict';

// Marco 9, M9-D231 — o imóvel que deixa de ser publicável sai do read model e dispara unpublish; eventos atualizam o registro.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe } = require('../../integrations/dispatch/dispatchHelpers');
const { Property, OutboxEvent } = require('../../../src/models');
const rm = require('../../../src/features/properties/publicReadModel');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { criarImovel } = require('../_helpers/intReadModel');

let tenant;
before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

const sincronizar = (id) => comTenant(tenant, (t) => rm.syncPublicPropertyReadModel(id, ctxDe(tenant), t));
const existe = (id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT 1 FROM real_estate.public_property_read_model WHERE property_id = :id', { replacements: { id }, transaction: t }))[0].length === 1);
const eventos = (id, eventType) => comTenant(tenant, (t) => OutboxEvent.findAll({ where: { aggregateId: id, eventType }, transaction: t }));
const alterar = (id, patch) => comTenant(tenant, (t) => Property.update(patch, { where: { id }, transaction: t }));

test('read_model_imovel_indisponivel_sai_e_despublica', async () => {
  const im = await criarImovel(tenant);
  await sincronizar(im.id);
  assert.equal(await existe(im.id), true);
  assert.equal((await eventos(im.id, 'property.public.changed')).length, 1, 'mudança dispara sync');
  assert.equal((await eventos(im.id, 'property.public.changed'))[0].payloadJson.propertyId, im.id);

  for (const [patch, motivo] of [
    [{ availabilityStatus: 'SOLD' }, 'NOT_AVAILABLE'],
    [{ availabilityStatus: 'AVAILABLE', publicationStatus: 'INACTIVE' }, 'PUBLICATION_NOT_ALLOWED'],
  ]) {
    await alterar(im.id, { availabilityStatus: 'AVAILABLE', publicationStatus: 'PUBLISHED' });
    await sincronizar(im.id);
    assert.equal(await existe(im.id), true, 'voltou a ser publicável');
    const antes = (await eventos(im.id, 'property.public.unpublish')).length;
    await alterar(im.id, patch);
    const r = await sincronizar(im.id);
    assert.equal(r.status, 'REMOVED');
    assert.ok(r.reasons.includes(motivo), `motivo ${motivo}`);
    assert.equal(await existe(im.id), false, 'o registro saiu');
    assert.equal((await eventos(im.id, 'property.public.unpublish')).length, antes + 1, 'unpublish disparado uma vez');
    assert.equal((await sincronizar(im.id)).status, 'ABSENT', 'repetir não dispara de novo');
    assert.equal((await eventos(im.id, 'property.public.unpublish')).length, antes + 1);
  }
  // Sem oferta ativa também sai.
  await alterar(im.id, { availabilityStatus: 'AVAILABLE', publicationStatus: 'PUBLISHED' });
  await comTenant(tenant, (t) => sequelize.query("UPDATE real_estate.property_offers SET status = 'PAUSED' WHERE id = :id", { replacements: { id: im.offerId }, transaction: t }));
  assert.ok((await sincronizar(im.id)).reasons.includes('NO_ACTIVE_OFFER'));
});

test('read_model_evento_do_imovel_recalcula', async () => {
  const im = await criarImovel(tenant);
  const evento = (eventType, payloadJson = {}) => ({ eventType, aggregateId: im.id, groupId: tenant.groupId, companyId: tenant.companyId, payloadJson });
  const ran = await comTenant(tenant, (t) => runEventConsumers(evento('property.updated'), t));
  assert.ok(ran.includes('properties.public_read_model'), 'o consumidor está registrado');
  assert.equal(await existe(im.id), true, 'property.updated criou o registro');
  await alterar(im.id, { availabilityStatus: 'SOLD' });
  await comTenant(tenant, (t) => runEventConsumers(evento('property.sold'), t));
  assert.equal(await existe(im.id), false, 'property.sold tirou o registro');
  await alterar(im.id, { availabilityStatus: 'AVAILABLE' });
  await comTenant(tenant, (t) => runEventConsumers({ ...evento('property.price.changed', { propertyId: im.id }), aggregateId: im.offerId }, t));
  assert.equal(await existe(im.id), true, 'o evento de preço traz o imóvel no payload');
});

test('read_model_isolado_por_empresa', async () => {
  const im = await criarImovel(tenant);
  await sincronizar(im.id);
  const { outro } = await carregarTenants();
  if (!outro) return;
  const vistoPela = await comTenant(outro, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM real_estate.public_property_read_model WHERE property_id = :id', { replacements: { id: im.id }, transaction: t }))[0][0].n);
  assert.equal(vistoPela, 0, 'a outra empresa não vê o registro');
  const fk = await sequelize.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'real_estate.public_property_read_model'::regclass");
  assert.deepEqual(fk[0][0], { relrowsecurity: true, relforcerowsecurity: true });
});
