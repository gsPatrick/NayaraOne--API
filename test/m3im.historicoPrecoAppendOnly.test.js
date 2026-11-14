'use strict';

/**
 * Marco 3, M3-08 (verificação independente de 11/11/2026): o histórico de preço é append-only TAMBÉM no banco. A sonda do
 * verificador fez UPDATE e DELETE em real_estate.property_price_history com o papel de runtime (nayara_runtime, sem BYPASSRLS).
 * Agora o gatilho recusa UPDATE, DELETE e TRUNCATE para qualquer papel (inclusive o dono) e o runtime não tem o privilégio.
 * Só em banco descartável (usa DATABASE_ADMIN_URL para provar que nem o superusuário altera sem derrubar o gatilho).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const { PropertyPriceHistory } = require('../src/models');

let tenant;
let admin;
let historyId;

before(async () => {
  if (!process.env.DATABASE_ADMIN_URL || process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  tenant = await getSeedTenant();
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  historyId = await withTenantTransaction(tenant, async (t) => {
    const p = await propertiesService.createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Histórico ${uniqueSuffix()}`, internalCode: `HP-${uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }, tenant.userId, t);
    const o = await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: 300000 }, tenant.userId, t);
    await offersService.updateOffer(p.id, o.id, { askingPrice: 290000 }, tenant.userId, t);
    const h = await PropertyPriceHistory.findOne({ where: { offerId: o.id, reasonCode: 'PRICE_UPDATE' }, transaction: t });
    return h.id;
  });
});

after(async () => {
  await admin.close();
  await sequelize.close();
});

const recusa = (err) => /append-only|PROPERTY_PRICE_HISTORY_APPEND_ONLY|permission denied/i.test(String(err && (err.original ? err.original.message : err.message)));

test('papel de runtime (sem BYPASSRLS) não altera nem apaga o histórico de preço', async () => {
  const [[papel]] = await sequelize.query('SELECT current_user AS u, rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = current_user');
  assert.equal(papel.bypass, false);
  assert.equal(papel.super, false);
  await assert.rejects(
    () => withRollbackTenantTransaction(tenant, (t) => sequelize.query('UPDATE real_estate.property_price_history SET new_price = 1 WHERE id = :id', { replacements: { id: historyId }, transaction: t })),
    recusa
  );
  await assert.rejects(
    () => withRollbackTenantTransaction(tenant, (t) => sequelize.query('DELETE FROM real_estate.property_price_history WHERE id = :id', { replacements: { id: historyId }, transaction: t })),
    recusa
  );
  await assert.rejects(() => withRollbackTenantTransaction(tenant, (t) => PropertyPriceHistory.destroy({ where: { id: historyId }, transaction: t })), recusa);
  const [[priv]] = await sequelize.query(
    "SELECT has_table_privilege(current_user, 'real_estate.property_price_history', 'UPDATE') AS upd, has_table_privilege(current_user, 'real_estate.property_price_history', 'INSERT') AS ins"
  );
  assert.equal(priv.ins, true, 'gravar histórico novo continua permitido');
});

test('nem o dono/superusuário altera, apaga ou trunca: o gatilho recusa', async () => {
  await assert.rejects(() => admin.query('UPDATE real_estate.property_price_history SET reason_code = :r WHERE id = :id', { replacements: { r: 'FORJADO', id: historyId } }), recusa);
  await assert.rejects(() => admin.query('DELETE FROM real_estate.property_price_history WHERE id = :id', { replacements: { id: historyId } }), recusa);
  await assert.rejects(() => admin.query('TRUNCATE real_estate.property_price_history CASCADE'), recusa);
  const [[linha]] = await admin.query('SELECT new_price, reason_code FROM real_estate.property_price_history WHERE id = :id', { replacements: { id: historyId } });
  assert.equal(Number(linha.new_price), 290000);
  assert.equal(linha.reason_code, 'PRICE_UPDATE');
});
