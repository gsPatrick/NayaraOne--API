'use strict';

// Revisão Marco 7 (19/10/2026), item A9: transferAsset com a MESMA chave de idempotência em
// duas conexões simultâneas. Sem trava consultiva, as duas leem "não existe" e a segunda estoura
// a UNIQUE (company_id, idempotency_key) de asset_movements com erro 500 em vez de devolver o
// movimento já gravado. Fixtures precisam estar commitadas (duas conexões) e são apagadas no
// finally — mesmo padrão de inventory.marco7.concurrency.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const assetsService = require('../src/features/inventory/assets.service');
const { AssetMovement } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function withCommitted(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  }
}

test('A9: duas transferências simultâneas com a mesma chave de idempotência devolvem o MESMO movimento (sem 500 por UNIQUE)', async () => {
  const suffix = uniqueSuffix();
  let assetId = null;
  const locationIds = [];
  try {
    const fx = await withCommitted(async (t) => {
      const origin = await itemsService.createLocation(withTenant({ name: `HOMO QA A9 Origem ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, t);
      const dest = await itemsService.createLocation(withTenant({ name: `HOMO QA A9 Destino ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, t);
      locationIds.push(origin.id, dest.id);
      const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA A9 ${suffix}`, assetTag: `REV19A9-${suffix}`, currentLocationId: origin.id }), tenant.userId, t);
      return { dest: dest.id, assetId: asset.id };
    });
    assetId = fx.assetId;

    // Barreira: as duas chamadas passam pela checagem "já existe?" antes de qualquer uma gravar.
    let arrived = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const timer = setTimeout(() => release(), 3000);
    const originalFindOne = AssetMovement.findOne;
    AssetMovement.findOne = async function intercepted(options = {}, ...rest) {
      const result = await originalFindOne.call(this, options, ...rest);
      if (options?.where?.idempotencyKey === `rev19-a9-${suffix}`) {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      }
      return result;
    };
    const key = `rev19-a9-${suffix}`;
    const transferir = () => withCommitted((t) => assetsService.transferAsset(fx.assetId, tenant.groupId, tenant.companyId, { destinationLocationId: fx.dest, idempotencyKey: key }, tenant.userId, t));
    let results;
    try {
      results = await Promise.allSettled([transferir(), transferir()]);
    } finally {
      AssetMovement.findOne = originalFindOne;
      clearTimeout(timer);
    }
    const summary = JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? 'ok' : `${r.reason?.name} ${r.reason?.code || ''} ${r.reason?.message}`)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, `as duas chamadas devem suceder: ${summary}`);
    assert.equal(results[0].value.id, results[1].value.id, 'a segunda chamada devolve o movimento da primeira');
    const count = await withCommitted((t) => AssetMovement.count({ where: { assetId: fx.assetId }, transaction: t }));
    assert.equal(count, 1, 'exatamente um movimento gravado');
  } finally {
    await withCommitted(async (t) => {
      if (assetId) {
        await sequelize.query('DELETE FROM inventory.asset_movements WHERE asset_id = :id', { replacements: { id: assetId }, transaction: t });
        await sequelize.query('DELETE FROM inventory.assets WHERE id = :id', { replacements: { id: assetId }, transaction: t });
      }
      for (const id of locationIds) {
        await sequelize.query('DELETE FROM inventory.locations WHERE id = :id', { replacements: { id }, transaction: t });
      }
    });
  }
});
