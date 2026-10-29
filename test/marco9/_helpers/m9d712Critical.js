'use strict';

// Apoio da M9-D712 / M9-D690: prova que toda métrica CRITICAL da tabela tem drill-down habilitado e que, nas que já têm especificação de
// origem registrada no código, o detalhe paginado devolve linhas cuja soma (ou contagem) bate com a consulta independente à tabela de origem.
const assert = require('node:assert/strict');
const env712 = require('./m9d712Env');
const ledger = require('./m9d615Ledger');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const PERMS = ['analytics:read', 'analytics:drilldown', 'finance:read', 'crm:opportunities:read', 'legal:read', 'construction:read', 'inventory:read',
  'correspondent:read', 'marketing:attribution:read', 'crm:feedback:read', 'analytics:read:tech'];
const PERIOD_TO = '2099-01-01T03:00:00.000Z';
const day = (n) => new Date(Date.UTC(2026, 9, 28 + n, 15)).toISOString();

async function insertLedger(env, tenant) {
  const base = { amount: '100.00' };
  const rows = [
    { nature: 'RECEIVABLE', status: 'SETTLED', settled: day(-3), amount: '1000.00' }, { nature: 'PAYABLE', status: 'SETTLED', settled: day(-2), amount: '250.50' },
    { nature: 'RECEIVABLE', status: 'SETTLED', settled: day(-1), amount: '300.00', third: true }, { nature: 'PAYABLE', status: 'PENDING', due: day(3), amount: '80.00' },
    { nature: 'PAYABLE', status: 'PENDING', due: day(-5), amount: '45.25' }, { nature: 'RECEIVABLE', status: 'PENDING', due: day(-8), amount: '600.00' },
    { nature: 'RECEIVABLE', status: 'PENDING', due: day(2), amount: '90.10' }, { nature: 'RECEIVABLE', status: 'REVERSED', due: day(2), amount: '10.00' },
  ];
  for (const r of rows) await ledger.entry(env, tenant, { ...base, ...r });
}

async function independent(env, spec, companyId) {
  const sign = spec.valueSign;
  const period = spec.columns && spec.columns.period;
  const value = spec.valueColumn ? (sign ? `CASE WHEN "${sign.column}" IN (${sign.negative.map((n) => `'${n}'`).join(',')}) THEN -"${spec.valueColumn}" ELSE "${spec.valueColumn}" END` : `"${spec.valueColumn}"`) : null;
  const [[r]] = await env.admin.query(`SELECT count(*)::int AS n${value ? `, COALESCE(SUM(${value}), 0)::text AS total` : ''} FROM ${spec.table} WHERE "${spec.companyColumn || 'company_id'}" = :c${period ? ` AND "${period}" < :to` : ''}`,
    { replacements: { c: companyId, to: PERIOD_TO } });
  return r;
}

/** env = { ...sup.setup(), created: [] } de m9d712Env/ledger. Devolve { checked, pending }. */
async function proveCriticalDrilldown(env) {
  const critical = seed.criticalCodes();
  assert.equal(critical.length, 33);
  const [defs] = await env.admin.query("SELECT metric_code, drilldown_enabled FROM analytics.metric_definitions WHERE company_id IS NULL AND group_id IS NULL AND criticality = 'CRITICAL'");
  assert.deepEqual(defs.map((d) => d.metric_code).sort(), [...critical].sort());
  assert.ok(defs.every((d) => d.drilldown_enabled === true), 'toda métrica CRITICAL nasce com drill-down habilitado');

  const t = env.tenantA;
  await insertLedger(env, t);
  const checked = [];
  const pending = [];
  await env712.inTx(t, {}, async (tx) => {
    await env712.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry(env712.GLOBAL_CTX, tx, { catalog: env.catalog, rows: env.rows, now: env712.todayMinus(10) });
    assert.equal(out.pending.length, 0);
    const ctx = env712.ctxOf(t, PERMS);
    for (const code of critical) {
      const top = registry.getSourceSpec(code);
      if (!top) { pending.push(code); continue; }
      for (const target of top.components || [code]) {
        const spec = registry.getSourceSpec(target);
        if (!spec || spec.components) continue;
        const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, target, { filter: spec.columns && spec.columns.period ? { period: { from: null, to: PERIOD_TO } } : {}, unit: 'BRL', domain: 'FINANCE' }, tx);
        const rows = [];
        let page = 1;
        let body;
        do {
          body = await openDrilldown(ctx, { metricCode: code, component: top.components ? target : undefined, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 3, route: 'teste' }, tx);
          rows.push(...body.rows);
          page += 1;
        } while (page <= body.totalPages);
        const expected = await independent(env, spec, t.companyId);
        assert.equal(rows.length, expected.n, `${target}: todas as páginas juntas devolvem todas as linhas`);
        if (spec.valueColumn && body.reconcileMode === 'SUM') {
          assert.equal(money.money(money.sum(rows.map((r) => r.contribution))), money.money(expected.total), `${target}: a soma do detalhe bate com a origem`);
        }
        checked.push(target);
      }
    }
  });
  return { checked, pending };
}

module.exports = { proveCriticalDrilldown, PERMS };
