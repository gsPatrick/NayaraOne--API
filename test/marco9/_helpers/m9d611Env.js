'use strict';

// Apoio dos testes da M9-D611 (sourceRefs): uma tabela de origem por família, especificações de origem registradas,
// catálogo de fórmulas de teste e fábrica de contexto com/sem permissão de detalhe. Roda SÓ em banco descartável (127.0.0.1).
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const registry = require('../../../src/features/analytics/metrics');
const security = require('../../../src/features/analytics/security');
const { FAMILIES, PERIOD, rowsFor } = require('./m9d611Families');

const tableOf = (env, f) => `m9d611_${f.key}_${env.sfx}`;

async function setup() {
  const base = await sup.setup();
  const env = { ...base, sfx: sup.sfx(), specs: [], formulas: {} };
  for (const f of FAMILIES) {
    const table = tableOf(env, f);
    await env.admin.query(`CREATE TABLE analytics.${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, status text NOT NULL, nature text NOT NULL,
      occurred_at timestamptz NOT NULL, amount numeric(18,2) NOT NULL, metric_a numeric(18,2) NOT NULL, flag boolean NOT NULL)`);
    await env.admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN GRANT SELECT ON analytics.${table} TO nayara_runtime; END IF; END $$`);
    const { inside, noise } = rowsFor(f, env.tenantA, env.tenantB);
    f.inside = inside;
    for (const r of [...inside, ...noise]) {
      await env.admin.query(`INSERT INTO analytics.${table} (company_id, status, nature, occurred_at, amount, metric_a, flag) VALUES (:c, :s, :n, :o, :a, :m, :f)`,
        { replacements: { c: r.company_id, s: r.status, n: r.nature, o: r.occurred_at, a: r.amount, m: r.metric_a, f: r.flag } });
    }
    const spec = {
      metricCode: f.code, type: `TESTE_${f.key.toUpperCase()}`, table: `analytics.${table}`,
      columns: { period: 'occurred_at', status: 'status', nature: 'nature' }, valueColumn: 'amount',
      ...(f.valueSign ? { valueSign: f.valueSign } : {}), ...(f.formula ? { formulaId: `${f.code}.formula`, rowColumns: ['metric_a', 'flag'] } : {}),
      describe: (filter) => `Linhas de teste ${f.key} da empresa no período ${filter.period.from} a ${filter.period.to}`,
    };
    env.specs.push(registry.registerSourceSpec(spec));
    if (f.formula) env.formulas[`${f.code}.formula`] = { id: `${f.code}.formula`, compute: f.formula };
  }
  env.catalog = { get: (id) => env.formulas[id] || null };
  return env;
}

async function teardown(env) {
  for (const f of FAMILIES) {
    registry.unregisterSourceSpec(f.code);
    await env.admin.query(`DROP TABLE IF EXISTS analytics.${tableOf(env, f)}`);
  }
  await sup.teardown({ ...env, readModel: env.readModel });
}

/** Filtro de cada família: empresa, período de outubro e status OK (e as duas naturezas, quando a família tem natureza). */
function filterOf(f) {
  return { period: PERIOD, status: ['OK'], ...(f.nature ? { nature: f.nature } : {}) };
}

/** Contexto do usuário: com `detail` tem permissão de detalhe e a de leitura da área; sem, só a leitura do BI. */
async function ctxFor(env, f, { detail = true, tenant } = {}, transaction) {
  const t = tenant || env.tenantA;
  const ctx = { groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:read'] };
  if (detail) {
    const map = await security.loadDomainMap(ctx, transaction);
    ctx.permissions = ['analytics:read', 'analytics:drilldown', security.domainPermissionOf(map, f.domain)];
  }
  return ctx;
}

module.exports = { setup, teardown, filterOf, ctxFor, tableOf, FAMILIES, PERIOD, inTx: sup.inTx, ctxOf: sup.ctxOf, metricInput: sup.metricInput, sequelize };
