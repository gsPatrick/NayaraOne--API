'use strict';

// M9-D712 — a semente cria a versão 1 de cada métrica com criticidade e value_nature, é idempotente e reclassificar exige nova versão.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env712 = require('../_helpers/m9d712Env');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');

let env;
before(async () => { env = await env712.setup(); });
after(() => env712.teardown(env));

const runSeed = (tx, options = {}) => seed.seedMetricRegistry(env712.GLOBAL_CTX, tx, { catalog: env.catalog, rows: env.rows, now: env712.todayMinus(10), ...options });
const inTx = (fn) => env712.inTx(env.tenantA, { writer: false }, async (tx) => {
  const { sequelize } = env712;
  await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
  return fn(tx);
});

test('m9d712 a semente cria a versao 1 de cada metrica com criticidade e value_nature e e idempotente', async () => {
  await inTx(async (tx) => {
    const first = await runSeed(tx);
    assert.equal(first.pending.length, 0, JSON.stringify(first.pending));
    assert.equal(first.published.length, 90);
    const second = await runSeed(tx);
    assert.equal(second.published.length, 0, 'segunda execução não publica de novo');
    assert.equal(second.created.length, 0);
    assert.equal(second.existing.length, 90);
    const [rows] = await env712.sequelize.query(
      `SELECT d.metric_code, d.status, d.criticality, d.drilldown_enabled, v.version, v.value_nature, v.unit, v.source_read_model
         FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
        WHERE d.company_id IS NULL AND d.group_id IS NULL ORDER BY d.metric_code`, { transaction: tx }
    );
    assert.equal(rows.length, 90);
    for (const spec of env.rows) {
      const r = rows.find((x) => x.metric_code === spec.code);
      assert.equal(r.status, 'PUBLISHED', spec.code);
      assert.equal(r.version, 1, spec.code);
      assert.equal(r.criticality, spec.criticality, spec.code);
      assert.equal(r.value_nature, spec.valueNature, `${spec.code}: value_nature segue M9-D610`);
      assert.equal(r.unit, spec.unit, spec.code);
      assert.equal(r.drilldown_enabled, spec.criticality === 'CRITICAL', spec.code);
    }
    const [[n]] = await env712.sequelize.query(
      "SELECT count(*)::int AS n FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id WHERE d.company_id IS NULL AND d.group_id IS NULL", { transaction: tx }
    );
    assert.equal(n.n, 90, 'uma versão por métrica, sem duplicar');
  });
});

test('m9d712 a semente sem fórmula ou sem read model deixa a definição DRAFT e nomeia o motivo', async () => {
  await inTx(async (tx) => {
    const none = { has: () => false, get: () => null, codeHash: () => null };
    const out = await runSeed(tx, { catalog: none });
    assert.equal(out.published.length, 0);
    assert.equal(out.pending.length, 90);
    assert.match(out.pending[0].reason, /fórmula .* ainda não existe/);
    const noRm = await runSeed(tx, { rows: env.rows.map((r) => ({ ...r, sourceReadModel: 'rm_m9d712_inexistente' })) });
    assert.equal(noRm.pending.length, 90);
    assert.match(noRm.pending[0].reason, /read model rm_m9d712_inexistente ainda não existe/);
    const [[d]] = await env712.sequelize.query("SELECT count(*)::int AS n FROM analytics.metric_definitions WHERE company_id IS NULL AND group_id IS NULL AND status = 'DRAFT'", { transaction: tx });
    assert.equal(d.n, 90);
  });
});

test('m9d712 reclassificar exige nova versao', async () => {
  await inTx(async (tx) => {
    await runSeed(tx);
    const ctx = env712.ctxOf(env.tenantA); // a reclassificação é feita por uma pessoa de uma empresa: a trilha de auditoria exige empresa e grupo
    await assert.rejects(
      () => registry.updateDefinition('fin.payables_30d', { scopeLevel: 'GLOBAL', criticality: 'CRITICAL' }, ctx, tx),
      (err) => err.statusCode === 409 && err.code === 'ANALYTICS_METRIC_REQUIRES_NEW_VERSION' && err.details.campos.includes('criticality')
    );
    const read = async () => (await env712.sequelize.query("SELECT criticality, drilldown_enabled FROM analytics.metric_definitions WHERE metric_code = 'fin.payables_30d' AND company_id IS NULL", { transaction: tx }))[0][0];
    assert.deepEqual(await read(), { criticality: 'NORMAL', drilldown_enabled: false }, 'a edição direta não mudou nada');
    const out = await registry.publishVersion('fin.payables_30d', { scopeLevel: 'GLOBAL', version: 2, criticality: 'CRITICAL', changeReason: 'Passa a alimentar o bloco de prazo crítico.', validFrom: new Date().toISOString().slice(0, 10) }, ctx, tx, { catalog: env.catalog, reasonMinChars: 10 });
    assert.equal(out.version.version, 2);
    assert.equal(out.changes.criticality.before, 'NORMAL');
    assert.equal(out.changes.criticality.after, 'CRITICAL');
    assert.deepEqual(await read(), { criticality: 'CRITICAL', drilldown_enabled: true }, 'a nova versão reclassificou e ligou o drill-down');
    await assert.rejects(
      () => registry.publishVersion('fin.payables_7d', { scopeLevel: 'GLOBAL', version: 2, criticality: 'URGENTE', changeReason: 'Teste de valor inválido.', validFrom: new Date().toISOString().slice(0, 10) }, ctx, tx, { catalog: env.catalog, reasonMinChars: 10 }),
      (err) => err.code === 'ANALYTICS_METRIC_INVALID'
    );
  });
});
