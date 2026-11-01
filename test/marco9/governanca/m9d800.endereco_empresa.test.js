'use strict';

// M9-D800 (reabertura R5-M2) — property_addresses não tem empresa própria: o serviço de imóveis precisa provar que o addressId
// recebido pertence a um imóvel da MESMA empresa. Duas empresas, banco descartável (scripts/withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d807Env');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');
const propertiesService = require('../../../src/features/properties/properties.service');

let tenants;
const created = [];
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => {
  for (const id of created) await adminQuery('DELETE FROM real_estate.properties WHERE id = $1', [id]).catch(() => {});
  await adminQuery("DELETE FROM real_estate.property_addresses WHERE street LIKE '%QA-M9 R5M2%'").catch(() => {});
  await env.sequelize.close();
});
const fail = (promise) => promise.then(() => null, (err) => err);
const ADDRESS = { zipCode: '01310-100', street: 'Rua Segredo QA-M9 R5M2', number: '999', neighborhood: 'Centro', city: 'Sao Paulo', state: 'SP' };
let n = 0;
const body = (tenant, extra) => { n += 1; return { groupId: tenant.groupId, companyId: tenant.companyId, title: `QA-M9 Imóvel R5M2 ${n}`, internalCode: `M9D800-R5M2-${Date.now()}-${n}`, propertyType: 'RESIDENTIAL', ...extra }; };
const create = (tenant, extra, tx) => propertiesService.createProperty(body(tenant, extra), tenant.userId, tx);

test('m9d800 R5-M2 addressId de outra empresa e id inexistente recebem a mesma resposta 404 (criação e atualização)', { skip: skip() }, async () => {
  const propB = await withTenantTransaction(tenants.B, (tx) => create(tenants.B, { address: ADDRESS }, tx));
  created.push(propB.id);
  assert.ok(propB.addressId);
  await withTenantTransaction(tenants.A, async (tx) => {
    const foreign = await fail(create(tenants.A, { addressId: propB.addressId }, tx));
    const missing = await fail(create(tenants.A, { addressId: env.randomUUID() }, tx));
    for (const err of [foreign, missing]) { assert.ok(err, 'deve recusar'); assert.equal(err.statusCode || err.status, 404); assert.equal(err.code, 'PROPERTY_ADDRESS_NOT_FOUND'); }
    assert.equal(foreign.message, missing.message, 'sem oráculo de existência');
    const own = await create(tenants.A, { address: ADDRESS }, tx);
    const upd = await fail(propertiesService.updateProperty(own.id, { addressId: propB.addressId }, tenants.A.userId, tx, tenants.A));
    assert.equal(upd && upd.code, 'PROPERTY_ADDRESS_NOT_FOUND');
    const upd2 = await fail(propertiesService.updateProperty(own.id, { addressId: env.randomUUID() }, tenants.A.userId, tx, tenants.A));
    assert.equal(upd2 && upd2.code, 'PROPERTY_ADDRESS_NOT_FOUND');
    throw Object.assign(new Error('desfaz'), { rollback: true });
  }).catch((err) => { if (!err.rollback) throw err; });
});

test('m9d800 R5-M2 a própria empresa continua reaproveitando o endereço de um imóvel seu', { skip: skip() }, async () => {
  const first = await withTenantTransaction(tenants.A, (tx) => create(tenants.A, { address: ADDRESS }, tx));
  created.push(first.id);
  const second = await withTenantTransaction(tenants.A, (tx) => create(tenants.A, { addressId: first.addressId }, tx));
  created.push(second.id);
  assert.equal(second.addressId, first.addressId);
  const cleared = await withTenantTransaction(tenants.A, (tx) => propertiesService.updateProperty(second.id, { addressId: null }, tenants.A.userId, tx, tenants.A));
  assert.equal(cleared.addressId, null);
});
