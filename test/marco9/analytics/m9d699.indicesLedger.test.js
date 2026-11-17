'use strict';

// M9-D699 (carga em escala cheia, 16/11/2026) — as consultas do detalhe dos indicadores financeiros usam os índices de leitura do BI em
// finance.financial_entries (migration 20261116235000) em vez de varrer o ledger inteiro. Massa da carga numa empresa (20 mil lançamentos),
// com estatística do planejador; o plano das consultas montadas pelo mesmo `buildWhere` da origem tem de passar pelo índice.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { seedLoad, cleanupLoad, connect } = require('../../../scripts/analytics/seedLoad');
const { buildWhere } = require('../../../src/features/analytics/metrics/sourceRefs.query');
const { getSourceSpec } = require('../../../src/features/analytics/metrics/sourceRefs.spec');
const { INDICES } = require('../../../src/modules/finance/infrastructure/db/migrations/20261116235000-finance-indices-leitura-do-bi');
require('../../../src/features/analytics');
const { sequelize } = require('../../testHelpers');

let admin;
let massa;
before(async () => {
  admin = connect();
  massa = await seedLoad(admin, { scale: 'light', seed: 'idx699', anchor: '2026-10-28', companies: 1, entries: 20000, bankTransactions: 1, opportunities: 1, properties: 1, projects: 1, stages: 1, measurements: 1, dailyReports: 1 });
});
after(async () => {
  if (massa) await cleanupLoad(admin, massa.companies);
  await admin.close();
  await sequelize.close();
});

async function plano(sql, replacements) {
  const [[row]] = await admin.query(`EXPLAIN (FORMAT JSON) ${sql}`, { replacements });
  return JSON.stringify(row['QUERY PLAN']);
}

async function planoDaOrigem(metricCode, filtro) {
  const spec = getSourceSpec(metricCode);
  const { where, replacements } = buildWhere(spec, { companyId: massa.companies[0].companyId, ...filtro });
  return plano(`SELECT count(*)::int AS n FROM "finance"."financial_entries" t WHERE ${where}`, replacements);
}

test('m9d699 os dois índices de leitura do BI existem no ledger com as colunas da migration', async () => {
  const [rows] = await admin.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'finance' AND tablename = 'financial_entries' AND indexname IN (:n)", { replacements: { n: INDICES.map((i) => i.nome) } });
  assert.equal(rows.length, 2);
  for (const { nome, colunas } of INDICES) assert.match(rows.find((r) => r.indexname === nome).indexdef, new RegExp(`\\(${colunas.replace(/, /g, ', ')}\\)$`));
});

test('m9d699 contas a pagar do mês (vencimento) e a parcela de transferências (liquidação) usam o índice, sem varrer o ledger', async () => {
  const filtro = { period: { from: '2026-10-01T03:00:00.000Z', to: '2026-11-01T03:00:00.000Z' }, status: ['PENDING'], nature: ['PAYABLE'], equals: { thirdParty: false, reversal: null } };
  const pagar = await planoDaOrigem('fin.payables_30d', filtro);
  assert.match(pagar, /financial_entries_bi_nature_status_due_idx/, pagar);
  assert.doesNotMatch(pagar, /"Seq Scan"/);
  const transferencias = await plano(`SELECT COALESCE(SUM(e.amount), 0) FROM finance.financial_entries e WHERE e.company_id = :c AND e.nature = 'ADJUSTMENT'
    AND e.idempotency_key LIKE 'intercompany-transfer:%' AND e.reversal_of_entry_id IS NULL AND e.status IN ('SETTLED') AND e.settled_at < :to`, { c: massa.companies[0].companyId, to: '2026-11-01T03:00:00.000Z' });
  assert.match(transferencias, /financial_entries_bi_nature_status_settled_idx/, transferencias);
  assert.doesNotMatch(transferencias, /"Seq Scan"/);
});
