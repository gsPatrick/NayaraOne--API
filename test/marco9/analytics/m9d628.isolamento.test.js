'use strict';

// M9-D628 — isolamento entre empresas (RLS), instantes gravados (source_snapshot_at, refreshed_at, version) e que o read model só recebe contagens e códigos. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const sc = require('../_helpers/m9d628Scenario');

let env;
let ids;
before(async () => {
  env = await env628.setup();
  ids = await sc.seedAll(env, env.tenantA);
  await sc.applyAll(env, env.tenantA, ids);
});
after(() => env628.teardown(env));

test('m9d628 isolamento entre empresas: o evento e a agenda de A não escrevem em B', async () => {
  for (const model of ['rm_tech_queues', 'rm_tech_integrations', 'rm_tech_blocked_events', 'rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls']) {
    assert.ok((await env628.rowsOf(env, model, env.tenantA)).length >= 1, `${model}: A tem linha`);
    assert.equal((await env628.rowsOf(env, model, env.tenantB)).length, 0, `${model}: B continua vazia`);
  }
  await env628.apply(env.tenantB, env628.makeEvent(env.tenantB, 'ai.run.completed', { runId: env628.uuid() }));
  assert.equal((await env628.rowsOf(env, 'rm_ai_cost', env.tenantB)).length, 0, 'B sem execuções de IA: nada para somar (os de A não vazam)');
  assert.equal((await env628.rowsOf(env, 'rm_ai_cost', env.tenantA)).length, 2, 'A não mudou');
});

test('m9d628 isolamento: sob a identidade de B (RLS) nenhuma linha de A é visível', async () => {
  for (const model of env628.MODELS) {
    const seenByB = await env628.inTx(env.tenantB, {}, async (tx) => (await env628.sequelize.query(`SELECT count(*)::int AS n FROM analytics.${model} WHERE company_id = :a`, { replacements: { a: env.tenantA.companyId }, transaction: tx }))[0][0].n);
    assert.equal(seenByB, 0, model);
  }
});

test('m9d628 source_snapshot_at, refreshed_at e version gravados', async () => {
  for (const model of env628.MODELS) {
    const rows = await env628.rowsOf(env, model, env.tenantA);
    if (!rows.length) continue;
    for (const r of rows) {
      assert.ok(r.source_snapshot_at instanceof Date && r.refreshed_at instanceof Date, `${model}: instantes`);
      assert.equal(r.version, 1, `${model}: version`);
    }
    assert.equal(new Date(rows[0].source_snapshot_at).getTime(), env628.NOW.getTime(), `${model}: a fonte foi lida em "agora" do relógio do BI`);
  }
});
