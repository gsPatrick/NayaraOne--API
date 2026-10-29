'use strict';

// M9-D618 — isolamento entre empresas (RLS) e carimbos de tempo (source_snapshot_at, refreshed_at, version) nos nove read models.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d618Scenario');

let env;
let idsA;
let idsB;
before(async () => {
  env = await bi.setup(sc.MODELS);
  idsA = await sc.seedAll(env, env.tenantA);
  idsB = await sc.seedAll(env, env.tenantB);
});
after(() => bi.teardown(env));

test('m9d618 source_snapshot_at e refreshed_at gravados', async () => {
  await sc.applyAll(env.tenantA, idsA);
  for (const model of sc.MODELS) {
    const rows = await bi.rowsOf(env, model, env.tenantA);
    assert.ok(rows.length >= 1, `${model} tem linhas`);
    for (const row of rows) {
      assert.equal(new Date(row.source_snapshot_at).toISOString(), bi.NOW.toISOString(), `${model}: instante da fotografia da fonte`);
      assert.ok(row.refreshed_at, `${model}: refreshed_at`);
      assert.equal(row.version, 1, `${model}: version`);
    }
  }
});

test('m9d618 isolamento entre empresas', async () => {
  const before = Object.fromEntries(await Promise.all(sc.MODELS.map(async (m) => [m, await bi.rowsOf(env, m, env.tenantA)])));
  await sc.applyAll(env.tenantB, idsB); // o mesmo conjunto de eventos na empresa B
  for (const model of sc.MODELS) {
    assert.deepEqual(await bi.rowsOf(env, model, env.tenantA), before[model], `${model}: só o read model de B muda`);
    assert.ok((await bi.rowsOf(env, model, env.tenantB)).length >= 1, `${model}: B tem linhas`);
    await bi.inTx(env.tenantA, {}, async (tx) => {
      const [rows] = await tx.sequelize.query(`SELECT DISTINCT company_id FROM analytics.${model}`, { transaction: tx });
      assert.deepEqual(rows.map((r) => r.company_id), [env.tenantA.companyId], `${model}: sob o RLS de A só aparecem linhas de A`);
    });
    await bi.inTx(env.tenantB, {}, async (tx) => {
      const [rows] = await tx.sequelize.query(`SELECT 1 FROM analytics.${model} WHERE company_id = :a`, { replacements: { a: env.tenantA.companyId }, transaction: tx });
      assert.equal(rows.length, 0, `${model}: B não enxerga A`);
    });
  }
  // a obra de A, citada num evento de B, não vira linha de B nem de A
  const stray = bi.makeEvent(env.tenantB, 'project.created', { id: idsA.p1 });
  await bi.apply(env.tenantB, stray);
  const b = await bi.rowsOf(env, 'rm_project_progress', env.tenantB);
  const strayRow = b.find((r) => r.project_id === idsA.p1);
  assert.equal(Number(strayRow.stages_total), 0, 'a empresa B não lê as etapas da empresa A (RLS e filtro de empresa)');
});

test('m9d618 escrita direta no read model é recusada fora do worker', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    await assert.rejects(tx.sequelize.query(`INSERT INTO analytics.rm_tool_assets (company_id, group_id, as_of_date) VALUES (:c, :g, '2026-01-01')`, {
      replacements: { c: env.tenantA.companyId, g: env.tenantA.groupId }, transaction: tx }), /row-level security|violates/i);
  });
});
