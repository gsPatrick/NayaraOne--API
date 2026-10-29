'use strict';

// M9-D699 — a massa de carga é determinística por semente: mesma semente, âncora e tamanhos dão as mesmas linhas e o mesmo digest.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { seedLoad, cleanupLoad, connect } = require('../../../scripts/analytics/seedLoad');
const { sizesFor } = require('../../../scripts/analytics/load/seed.sizes');
const { sequelize } = require('../../testHelpers');

const SMALL = { scale: 'light', anchor: '2026-10-28', companies: 2, entries: 300, bankTransactions: 60, opportunities: 80, properties: 40, projects: 6, stages: 18, measurements: 50, dailyReports: 50 };
let admin;
before(() => { admin = connect(); });
after(async () => { await admin.close(); await sequelize.close(); });

const count = async (companies) => (await admin.query('SELECT (SELECT count(*) FROM finance.financial_entries WHERE company_id IN (:ids))::int AS n', { replacements: { ids: companies.map((c) => c.companyId) } }))[0][0].n;

test('m9d699 massa determinística reproduzível', async () => {
  const first = await seedLoad(admin, { ...SMALL, seed: 'a1' });
  assert.equal(first.companies.length, 2);
  assert.equal(await count(first.companies), 600, 'duas empresas com 300 lançamentos');
  assert.equal(first.rows['finance.financial_entries'], 600);
  assert.equal(first.rows['construction.daily_reports'], 100);
  await cleanupLoad(admin, first.companies);
  assert.equal(await count(first.companies), 0, 'a limpeza apaga a massa');

  const second = await seedLoad(admin, { ...SMALL, seed: 'a1' });
  assert.deepEqual(second.companies, first.companies, 'os ids das empresas vêm da semente');
  assert.equal(second.digest, first.digest, 'mesma semente: mesmas linhas, mesmo digest');
  await cleanupLoad(admin, second.companies);

  const other = await seedLoad(admin, { ...SMALL, seed: 'b2' });
  assert.notEqual(other.digest, first.digest, 'outra semente: outra massa');
  await cleanupLoad(admin, other.companies);
});

test('m9d699 o histórico cobre 24 meses e a massa traz lançamentos pagos, pendentes e cancelados', async () => {
  const run = await seedLoad(admin, { ...SMALL, seed: 'c3', companies: 1, entries: 2000 });
  const ids = run.companies.map((c) => c.companyId);
  const [[span]] = await admin.query("SELECT count(DISTINCT competence_month)::int AS months, min(competence_month) AS first, max(competence_month) AS last FROM finance.financial_entries WHERE company_id IN (:ids)", { replacements: { ids } });
  assert.equal(span.last, '2026-10');
  assert.ok(span.months >= 23 && span.months <= 25, `meses distintos: ${span.months}`);
  const [byStatus] = await admin.query('SELECT status, count(*)::int AS n FROM finance.financial_entries WHERE company_id IN (:ids) GROUP BY 1 ORDER BY 1', { replacements: { ids } });
  assert.deepEqual(byStatus.map((r) => r.status), ['CANCELLED', 'PENDING', 'SETTLED']);
  assert.equal(sizesFor({ scale: 'full' }).months, 24);
  await cleanupLoad(admin, run.companies);
});

test('m9d699 a massa só entra em banco descartável em 127.0.0.1', () => {
  assert.throws(() => connect('postgres://u:p@db.exemplo.invalid:5432/x'), /127\.0\.0\.1/);
  assert.throws(() => sizesFor({ scale: 'gigante' }), /Escala desconhecida/);
});
