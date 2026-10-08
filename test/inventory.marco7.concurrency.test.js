'use strict';

// Auditoria de conformidade contratual Marco 7 (2026-10-07) — EST-TS-02 e EST-TS-15.
//
// O código de lock (SELECT ... FOR UPDATE) já existia em movements.service.js
// (applyBalanceDelta) e assets.service.js (transferAsset), mas nenhum teste provava o
// comportamento sob concorrência REAL. Estes testes abrem DUAS transações Sequelize
// independentes (duas conexões distintas do pool, cada uma com seu próprio SET LOCAL de
// tenant) e as disparam em paralelo (Promise.allSettled). Por isso os dados de fixture
// precisam estar COMMITADOS (uma transação não enxerga dados não commitados da outra) — e são
// removidos via SQL no `finally` para não poluir o banco de dev compartilhado (mesmo padrão de
// ADV-F21 em adversarial.finance.test.js e CICLO1-COMPRAS-01 em procurement.cycle1.test.js).
//
// Barreira de sincronização: interceptamos a leitura com lock feita DENTRO do service e
// seguramos as duas chamadas até que AMBAS tenham chegado ali — só então liberamos as duas
// para emitir o SELECT ... FOR UPDATE. Isso garante que a corrida de verdade acontece
// (independente da latência do banco remoto), em vez de depender de sorte de timing.
//
// Sobre deadlock (40P01): nos dois cenários as duas transações disputam UM ÚNICO recurso
// travável (a mesma linha de stock_balances / a mesma linha de assets), adquirido na mesma
// ordem. Com um único lock exclusivo não existe ciclo de espera possível — o Postgres precisa
// SERIALIZAR (a segunda espera o commit da primeira e, em READ COMMITTED, relê a versão já
// commitada da linha). Por isso NÃO há retry de 40P01 aqui: um deadlock entre estas duas
// transações seria um achado real (ordem de lock inconsistente), não ruído de ambiente — as
// fixtures são exclusivas deste teste (item/local/asset criados com sufixo único), então outros
// agentes rodando em paralelo no mesmo banco não disputam essas linhas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const assetsService = require('../src/features/inventory/assets.service');
const { InventoryStockBalance, InventoryMovement, Asset, AssetMovement } = require('../src/models');
const AppError = require('../src/utils/AppError');

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

// Barreira para N chegadas, com fallback de tempo (se o lock serializar uma das chamadas antes
// dela chegar ao ponto interceptado, a barreira não pode travar o teste para sempre).
function createBarrier(parties, fallbackMs = 5000) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release('timeout'), fallbackMs);
  let pending = parties;
  let releasedBy = null;
  return {
    async arrive() {
      pending -= 1;
      if (pending === 0) {
        releasedBy = 'all-arrived';
        clearTimeout(timer);
        release('all-arrived');
      }
      const how = await gate;
      if (!releasedBy) releasedBy = how;
    },
    get releasedBy() {
      return releasedBy;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

function describeSettled(results) {
  return JSON.stringify(
    results.map((r) => (r.status === 'fulfilled' ? 'ok' : `${r.reason?.code || r.reason?.parent?.code || ''} ${String(r.reason?.message || r.reason)}`))
  );
}

test('EST-TS-02: duas saídas concorrentes disputando o último saldo — uma vence, a outra é bloqueada por saldo insuficiente', async () => {
  const suffix = uniqueSuffix();
  let itemId = null;
  let locationId = null;
  try {
    // Fixture COMMITADA: item + local + entrada de 10 unidades.
    ({ itemId, locationId } = await withCommitted(async (t) => {
      const item = await itemsService.createItem(
        withTenant({ name: `HOMO QA EST-TS-02 ${suffix}`, sku: `ESTTS02-${suffix}`, unitOfMeasure: 'UN' }),
        tenant.userId,
        t
      );
      const location = await itemsService.createLocation(
        withTenant({ name: `HOMO QA Deposito EST-TS-02 ${suffix}`, locationType: 'WAREHOUSE' }),
        tenant.userId,
        t
      );
      await movementsService.recordMovement(
        withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: location.id, reason: 'Saldo inicial EST-TS-02' }),
        { userId: tenant.userId, canApprove: false },
        t
      );
      return { itemId: item.id, locationId: location.id };
    }));

    // Barreira no ponto exato do lock: applyBalanceDelta chama InventoryStockBalance.findOne
    // com lock FOR UPDATE. Só interceptamos chamadas deste item (o banco é compartilhado).
    const barrier = createBarrier(2);
    const originalFindOne = InventoryStockBalance.findOne;
    let lockedReads = 0;
    InventoryStockBalance.findOne = async function interceptedFindOne(options = {}, ...rest) {
      if (options?.where?.inventoryItemId === itemId && options.lock) {
        lockedReads += 1;
        await barrier.arrive();
      }
      return originalFindOne.call(this, options, ...rest);
    };

    // Cada saída pede 7 de um saldo de 10: qualquer uma sozinha cabe, as duas juntas não.
    const saida = (n) =>
      withCommitted((t) =>
        movementsService.recordMovement(
          withTenant({ inventoryItemId: itemId, movementType: 'OUT', quantity: 7, sourceLocationId: locationId, reason: `Saída concorrente ${n}` }),
          { userId: tenant.userId, canApprove: false },
          t
        )
      );

    let results;
    try {
      results = await Promise.allSettled([saida(1), saida(2)]);
    } finally {
      InventoryStockBalance.findOne = originalFindOne;
      barrier.dispose();
    }

    assert.equal(lockedReads, 2, 'as duas transações precisam ter chegado à leitura com lock (corrida real)');
    assert.equal(barrier.releasedBy, 'all-arrived', 'as duas transações precisam estar simultaneamente no ponto do lock antes de prosseguir');

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, `exatamente UMA saída deve vencer: ${describeSettled(results)}`);
    assert.equal(failed.length, 1, `exatamente UMA saída deve ser bloqueada: ${describeSettled(results)}`);
    const err = failed[0].reason;
    assert.ok(err instanceof AppError, `a perdedora deve falhar com AppError de negócio (não deadlock/erro de banco): ${describeSettled(results)}`);
    assert.equal(err.code, 'INVENTORY_INSUFFICIENT_BALANCE');
    assert.match(err.message, /disponível: 3/, 'a perdedora precisa ter enxergado o saldo JÁ debitado pela vencedora (3), não o saldo antigo (10)');

    // Estado final consistente, lido numa transação nova.
    await withCommitted(async (t) => {
      const balance = await movementsService.getBalance(itemId, locationId, t);
      assert.equal(balance, 3, 'saldo final = 10 - 7 (nunca negativo, nunca -4)');
      const outs = await InventoryMovement.count({ where: { inventoryItemId: itemId, movementType: 'OUT' }, transaction: t });
      assert.equal(outs, 1, 'só o movimento da vencedora fica no ledger (o da perdedora sofreu rollback junto com a transação)');
    });
  } finally {
    if (itemId) {
      await withCommitted(async (t) => {
        await sequelize.query('DELETE FROM inventory.inventory_movements WHERE inventory_item_id = :id', { replacements: { id: itemId }, transaction: t });
        await sequelize.query('DELETE FROM inventory.stock_balances WHERE inventory_item_id = :id', { replacements: { id: itemId }, transaction: t });
        await sequelize.query('DELETE FROM inventory.inventory_items WHERE id = :id', { replacements: { id: itemId }, transaction: t });
        if (locationId) await sequelize.query('DELETE FROM inventory.locations WHERE id = :id', { replacements: { id: locationId }, transaction: t });
      });
    }
  }
});

test('EST-TS-15: duas transferências concorrentes do mesmo asset serializam via FOR UPDATE — cadeia de movimentos consistente, sem estado misto', async () => {
  const suffix = uniqueSuffix();
  let assetId = null;
  const locationIds = [];
  try {
    const fixture = await withCommitted(async (t) => {
      const mk = async (label) => {
        const loc = await itemsService.createLocation(withTenant({ name: `HOMO QA EST-TS-15 ${label} ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, t);
        locationIds.push(loc.id);
        return loc.id;
      };
      const origin = await mk('Origem');
      const destA = await mk('DestinoA');
      const destB = await mk('DestinoB');
      const asset = await assetsService.createAsset(
        withTenant({ name: `HOMO QA Asset EST-TS-15 ${suffix}`, assetTag: `ESTTS15-${suffix}`, currentLocationId: origin }),
        tenant.userId,
        t
      );
      return { origin, destA, destB, assetId: asset.id, initialVersion: asset.lockVersion };
    });
    assetId = fixture.assetId;

    const barrier = createBarrier(2);
    const originalFindByPk = Asset.findByPk;
    let lockedReads = 0;
    Asset.findByPk = async function interceptedFindByPk(pk, options = {}, ...rest) {
      if (pk === assetId && options?.lock) {
        lockedReads += 1;
        await barrier.arrive();
      }
      return originalFindByPk.call(this, pk, options, ...rest);
    };

    const transferir = (dest) => withCommitted((t) => assetsService.transferAsset(assetId, { destinationLocationId: dest }, tenant.userId, t));

    let results;
    try {
      results = await Promise.allSettled([transferir(fixture.destA), transferir(fixture.destB)]);
    } finally {
      Asset.findByPk = originalFindByPk;
      barrier.dispose();
    }

    assert.equal(lockedReads, 2, 'as duas transações precisam ter chegado à leitura com lock (corrida real)');
    assert.equal(barrier.releasedBy, 'all-arrived', 'as duas transações precisam estar simultaneamente no ponto do lock');

    // Com FOR UPDATE a segunda transação espera o commit da primeira e relê a linha já
    // atualizada (READ COMMITTED) — o lockVersion lido é o novo, então o save otimista também
    // passa. Resultado correto = AMBAS sucedem, em série. Qualquer rejeição aqui (em especial
    // 40P01 deadlock ou OptimisticLockError) indicaria lock incorreto.
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, `as duas transferências devem serializar e suceder: ${describeSettled(results)}`);

    await withCommitted(async (t) => {
      const asset = await Asset.findByPk(assetId, { transaction: t });
      const movements = await AssetMovement.findAll({ where: { assetId }, transaction: t });
      assert.equal(movements.length, 2, 'cada transferência commitada gera exatamente um asset_movement');

      // A primeira a obter o lock sai da origem; a segunda precisa sair de ONDE A PRIMEIRA
      // DEIXOU o asset (nunca da origem antiga — isso seria a leitura "suja"/estado misto).
      const first = movements.find((m) => m.sourceLocationId === fixture.origin);
      assert.ok(first, 'um dos movimentos parte da origem original');
      const second = movements.find((m) => m.id !== first.id);
      assert.equal(second.sourceLocationId, first.destinationLocationId, 'o 2º movimento parte do destino do 1º (serialização correta, sem lost update)');
      assert.notEqual(second.destinationLocationId, first.destinationLocationId);
      assert.deepEqual(
        new Set([first.destinationLocationId, second.destinationLocationId]),
        new Set([fixture.destA, fixture.destB])
      );
      assert.equal(asset.currentLocationId, second.destinationLocationId, 'localização final do asset = destino da última transferência commitada');
      assert.equal(asset.lockVersion, fixture.initialVersion + 2, 'lockVersion incrementado uma vez por transferência (nenhuma escrita perdida)');
    });
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
