'use strict';

// M9-D432 — custo real da campanha vindo do Financeiro (somente leitura). Postgres real, role de runtime (RLS FORCE), rollback.
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test test/marco9/marketing/m9d432.custo.test.js

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const fx = require('../_helpers/m9d432Fixtures');
const cost = require('../../../src/features/marketing/campaigns/cost.service');
const campaigns = require('../../../src/features/marketing/campaigns').service;
const lifecycle = require('../../../src/features/marketing/campaigns').lifecycle;
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenant;
let tenantB;
before(async () => { ({ a: tenant, b: tenantB } = await fx.tenants()); });
after(async () => { await sequelize.close(); });
afterEach(() => cost.setCostReaderForTests(null));

const recalc = (t, id, now) => cost.recalculateCampaignCost(id, tenant, t, now ? { now } : {});

/** Os três lançamentos do livro: R$ 4.000,00 (referência), R$ 3.500,00 (centro de custo) e R$ 1.680,00 (referência). */
async function exemplo(t, camp) {
  const cc = await fx.costCenter(t, tenant, camp.code);
  const a = await fx.expense(t, tenant, { amount: 4000, ref: `campaign:${camp.id}` });
  const b = await fx.expense(t, tenant, { amount: 3500, cc });
  const c = await fx.expense(t, tenant, { amount: 1680, ref: `campaign:${camp.id}` });
  return { a, b, c, cc };
}

test('custo_real_soma_lancamentos_pagos: 4.000 + 3.500 + 1.680 = 9.180 e saldo 2.820', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    await exemplo(t, camp);
    await fx.expense(t, tenant, { amount: 999, ref: `campaign:${camp.id}`, settle: false }); // pendente: não é realizado
    await fx.expense(t, tenant, { amount: 777 }); // sem vínculo
    const out = await recalc(t, camp.id);
    assert.equal(out.costActual, 9180);
    const dto = await campaigns.getCampaign(tenant, camp.id, t);
    assert.equal(dto.costActual, 9180);
    assert.equal(dto.budgetAmount - dto.costActual, 2820);
    assert.deepEqual(dto.warnings, []);
    assert.ok(dto.costUpdatedAt);
    assert.equal((await recalc(t, camp.id)).costActual, 9180, 'recalcular é idempotente');
  });
});

test('estornado_nao_conta: estorno total sai da soma e o parcial é subtraído', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    const { c } = await exemplo(t, camp);
    await fx.financial.reverseFinancialEntry(c.id, 'QA-M9 estorno do lançamento de 1.680', tenant.userId, t);
    assert.equal((await recalc(t, camp.id)).costActual, 7500);
    const cancelled = await fx.expense(t, tenant, { amount: 300, ref: `campaign:${camp.id}`, settle: false });
    await fx.financial.cancelPendingFinancialEntry(cancelled.id, 'QA-M9 cancelado', tenant.userId, t);
    assert.equal((await recalc(t, camp.id)).costActual, 7500, 'cancelado não conta');
    const extra = await fx.expense(t, tenant, { amount: 1000, ref: `campaign:${camp.id}` });
    await fx.financial.reverseFinancialEntry(extra.id, 'QA-M9 estorno parcial', tenant.userId, t, { amount: 400 });
    assert.equal((await recalc(t, camp.id)).costActual, 8100);
  });
});

test('baixa_parcial_nao_conta_duas_vezes: a baixa herda o vínculo e a origem liquidada não repete', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    const entry = await fx.expense(t, tenant, { amount: 1000, ref: `campaign:${camp.id}`, settle: false });
    await fx.partialPayment(t, tenant, entry, 400);
    assert.equal((await recalc(t, camp.id)).costActual, 400);
    await fx.partialPayment(t, tenant, entry, 600, { last: true });
    assert.equal((await recalc(t, camp.id)).costActual, 1000);
  });
});

test('marketing_nao_escreve_no_financeiro: o recálculo não altera o ledger nem deixa rastro nele', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    await exemplo(t, camp);
    const before = await fx.ledgerSnapshot(t, tenant);
    await recalc(t, camp.id);
    await lifecycle.runLifecycleTick(tenant, t, new Date());
    assert.deepEqual(await fx.ledgerSnapshot(t, tenant), before);
    // a leitura é só SELECT: nenhum comando de escrita no código que toca o Financeiro
    const src = fs.readFileSync(path.join(__dirname, '../../../src/features/marketing/campaigns/cost.reader.js'), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  });
});

test('fonte_indisponivel_nao_zera: mantém o último valor, avisa MKT_COST_SOURCE_STALE e volta ao normal', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    await exemplo(t, camp);
    const first = new Date('2026-11-01T10:00:00Z');
    await recalc(t, camp.id, first);
    cost.setCostReaderForTests(async () => { throw new Error('financeiro fora do ar'); });
    const out = await recalc(t, camp.id, new Date('2026-11-02T10:00:00Z'));
    assert.equal(out.stale, true);
    assert.equal(out.costActual, 9180);
    const dto = await campaigns.getCampaign(tenant, camp.id, t);
    assert.equal(dto.costActual, 9180);
    assert.deepEqual(dto.warnings, [{ code: 'MKT_COST_SOURCE_STALE', message: 'Custo não atualizado desde a última consulta.', lastUpdatedAt: first.toISOString() }]);
    assert.equal(new Date((await fx.costOf(t, camp.id)).cost_updated_at).toISOString(), first.toISOString());
    cost.setCostReaderForTests(null);
    await recalc(t, camp.id);
    assert.deepEqual((await campaigns.getCampaign(tenant, camp.id, t)).warnings, []);
  });
});

test('lancamento_de_outra_empresa_nao_entra: referência e centro de custo de outra empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    await fx.expense(t, tenant, { amount: 100, ref: `campaign:${camp.id}` });
    await fx.asTenant(t, tenant, tenantB, async () => {
      await fx.expense(t, tenantB, { amount: 5000, ref: `campaign:${camp.id}` });
      await fx.expense(t, tenantB, { amount: 6000, cc: await fx.costCenter(t, tenantB, camp.code) });
    });
    assert.equal((await recalc(t, camp.id)).costActual, 100);
  });
});

test('referencia_da_campanha_vence_o_centro_de_custo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const campA = await fx.runningCampaign(t, tenant);
    const campB = await fx.runningCampaign(t, tenant);
    const ccB = await fx.costCenter(t, tenant, campB.code);
    await fx.expense(t, tenant, { amount: 2000, ref: `campaign:${campA.id}`, cc: ccB }); // referência A + centro de B: vale A
    await fx.expense(t, tenant, { amount: 700, cc: ccB }); // só o centro de custo: vale B
    await fx.expense(t, tenant, { amount: 50, ref: 'NF-123', cc: ccB }); // referência que não é de campanha: o centro vale
    assert.equal((await recalc(t, campA.id)).costActual, 2000);
    assert.equal((await recalc(t, campB.id)).costActual, 750);
  });
});

test('fonte_financeiro_desligada: o custo fica em 0 e o orçamento é o único custo, sem aviso', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant);
    await fx.expense(t, tenant, { amount: 300, ref: `campaign:${camp.id}` });
    await upsertSetting('marketing.custos.fonte_financeiro_ativa', false, tenant, tenant.userId, t);
    const out = await recalc(t, camp.id);
    assert.equal(out.skipped, true);
    const dto = await campaigns.getCampaign(tenant, camp.id, t);
    assert.deepEqual([dto.costActual, dto.warnings], [0, []]);
  });
});

test('job_diario_e_encerramento: recalcula no intervalo configurado e uma última vez ao encerrar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.runningCampaign(t, tenant, { endsAt: '2026-12-31T00:00:00Z' });
    await fx.expense(t, tenant, { amount: 1000, ref: `campaign:${camp.id}` });
    const day1 = new Date('2026-11-01T10:00:00Z');
    const mine = (res) => [...res.costs.recalculated, ...res.costs.stale].includes(camp.id);
    assert.ok(mine(await lifecycle.runLifecycleTick(tenant, t, day1)));
    assert.equal(Number((await fx.costOf(t, camp.id)).cost_actual), 1000);
    await fx.expense(t, tenant, { amount: 500, ref: `campaign:${camp.id}` });
    assert.ok(!mine(await lifecycle.runLifecycleTick(tenant, t, new Date('2026-11-01T20:00:00Z'))), 'dentro das 24 h não recalcula');
    assert.equal(Number((await fx.costOf(t, camp.id)).cost_actual), 1000);
    assert.ok(mine(await lifecycle.runLifecycleTick(tenant, t, new Date('2026-11-02T11:00:00Z'))));
    assert.equal(Number((await fx.costOf(t, camp.id)).cost_actual), 1500);
    // encerramento: lançamento novo entra no custo final
    await fx.expense(t, tenant, { amount: 250, ref: `campaign:${camp.id}` });
    await lifecycle.endCampaign(camp.id, tenant, new Date('2027-01-01T00:00:00Z'), t);
    const [ended] = await fx.q(t, 'SELECT status, cost_actual FROM marketing.campaigns WHERE id = :id', { id: camp.id });
    assert.deepEqual([ended.status, Number(ended.cost_actual)], ['ENDED', 1750]);
  });
});
