'use strict';

// Apoio dos testes da M9-D696 sobre o read model REAL do Financeiro (rm_finance_health): lançamentos no ledger, aplicação do evento pelo
// worker e execução dos checks do catálogo. Banco descartável apenas.
const env615 = require('./m9d615Env');
const quality = require('../../../src/features/analytics/quality');
const clock = require('../../../src/features/analytics/metrics/clock');
const readModels = require('../../../src/features/analytics/read-models');
const { flushBatch } = require('../../../src/features/analytics/read-models/readModel.batch');
const refreshStore = require('../../../src/features/analytics/readModelRefreshStore.service');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');

const { NOW, ledger } = env615;
const iso = (days, hour = 15) => new Date(Date.UTC(2026, 9, 28 + days, hour)).toISOString();

async function setup() {
  const env = await env615.setup();
  clock.setClock(() => NOW);
  // Outros testes (que usam o relógio real) deixam linhas de outras datas-base: o check lê a MAIS RECENTE, então elas são tiradas daqui.
  await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id IN (:c) AND as_of_date <> '2026-10-28'", { replacements: { c: [env.tenantA.companyId, env.tenantB.companyId] } });
  return env;
}

async function teardown(env) {
  clock.resetClock();
  await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.qualidade.%' OR key LIKE 'analytics.freshness.%'");
  await env615.teardown(env);
}

/** Caixa livre 120.000,00 (125.000 - 5.000), terceiros 3.000, recebíveis 10.000 em 7d / 5.000 até 30d / 2.000 até 60d. */
async function seedLedger(env, tenant) {
  const e = (c) => ledger.entry(env, tenant, c);
  await e({ nature: 'RECEIVABLE', amount: '125000.00', status: 'SETTLED', settled: iso(-3), month: '2026-10', center: null });
  await e({ nature: 'PAYABLE', amount: '5000.00', status: 'SETTLED', settled: iso(-2), month: '2026-10', center: null });
  await e({ nature: 'RECEIVABLE', amount: '3000.00', status: 'SETTLED', settled: iso(-1), month: '2026-10', third: true });
  await e({ nature: 'RECEIVABLE', amount: '10000.00', status: 'PENDING', due: iso(3) });
  await e({ nature: 'RECEIVABLE', amount: '5000.00', status: 'PENDING', due: iso(20) });
  await e({ nature: 'RECEIVABLE', amount: '2000.00', status: 'PENDING', due: iso(45) });
  await e({ nature: 'PAYABLE', amount: '4000.00', status: 'PENDING', due: iso(5) });
  return e({ nature: 'PAYABLE', amount: '1000.00', status: 'PENDING', due: iso(25) });
}

let tick = 0;

/** Aplica um evento do Financeiro e fecha o lote como o despacho do outbox faz; devolve a linha do refresh do lote. */
async function applyAndRefresh(env, tenant, id) {
  const now = new Date(NOW.getTime() + (++tick) * 60000); // cada lote fora do intervalo mínimo entre conferências (lote_segundos)
  const event = env615.makeEvent(tenant, 'finance.entry.settled', { id, resultCenterId: null, competenceMonth: '2026-10' });
  const [row] = await env615.inTx(tenant, { commit: true }, async (tx) => {
    await readModels.applyEvent(event, tx, { now: NOW });
    return flushBatch(tx, { now });
  });
  return row;
}

/** Abre um refresh fechado como SUCCEEDED (rows linhas) e roda os checks do catálogo do read model. */
async function check(env, tenant, readModel, { rows = 1, mode = 'EVENT', table } = {}) {
  return env615.inTx(tenant, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    const r = await refreshStore.startRefresh({ groupId: tenant.groupId, companyId: tenant.companyId, readModel, trigger: 'EVENT', version: 1 }, tenant, tx);
    const done = await refreshStore.finishRefresh(r.id, { status: 'SUCCEEDED', rowsUpserted: rows, sourceSnapshotAt: NOW }, tenant, tx);
    const out = await quality.checkRefresh({ readModel, scope: { companyId: tenant.companyId, groupId: tenant.groupId }, refreshId: done.id, rowsUpserted: rows, mode, table }, tx);
    return { ...out, refreshId: done.id };
  });
}

const refreshRow = async (env, tenant) => (await env.admin.query(
  "SELECT * FROM analytics.read_model_refreshes WHERE read_model = 'rm_finance_health' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: tenant.companyId } }
))[0][0];
const setHealth = (env, tenant, set) => env.admin.query(
  `UPDATE analytics.rm_finance_health SET ${Object.keys(set).map((k) => `${k} = :${k}`).join(', ')} WHERE company_id = :c AND as_of_date = '2026-10-28'`, { replacements: { ...set, c: tenant.companyId } }
);
const statusOf = (out, code) => out.results.find((r) => r.checkCode === code);

module.exports = { ledger, setup, teardown, seedLedger, applyAndRefresh, check, refreshRow, setHealth, statusOf, healthRow: env615.healthRow, apply: env615.apply, makeEvent: env615.makeEvent, inTx: env615.inTx, NOW, iso };
