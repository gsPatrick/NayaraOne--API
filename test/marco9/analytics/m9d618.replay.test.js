'use strict';

// M9-D618 — replay do mesmo evento e atomicidade: o helper compartilhado assertReplayIdempotent (M9-D607) sobre cada um dos nove read models.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d618Scenario');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

// evento -> read models que ele atualiza (cada um conferido isoladamente pelo replay)
const CASES = [
  ['project.created', (i) => ({ id: i.p1 }), ['rm_project_progress', 'rm_project_cost', 'rm_project_delays']],
  ['measurement.approved', (i) => ({ projectStageId: i.s1 }), ['rm_project_measurements']],
  ['nonconformity.opened', (i) => ({ projectId: i.p1 }), ['rm_project_nonconformities']],
  ['inventory.movement.recorded', (i) => ({ id: i.moves[0] }), ['rm_project_waste', 'rm_inventory_health']],
  ['warranty.case.opened', (i) => ({ id: i.cases.c1 }), ['rm_postwork_cost']],
  ['tool.loan.created', () => ({}), ['rm_tool_assets']],
];

test('m9d618 replay do mesmo evento não duplica', async () => {
  const covered = new Set();
  for (const [type, payloadOf, models] of CASES) {
    const event = bi.makeEvent(env.tenantA, type, payloadOf(ids));
    const snapshot = async () => Object.fromEntries(await Promise.all(models.map(async (m) => [m, await bi.rowsOf(env, m, env.tenantA)])));
    const { first, before: rows } = await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(env.tenantA, event), readRow: snapshot });
    assert.ok(first.upserted >= models.length, `${type} aplicou em ${models.join(', ')}`);
    for (const m of models) { assert.ok(rows[m].length >= 1, `${m} tem linha`); covered.add(m); }
  }
  assert.deepEqual([...covered].sort(), [...sc.MODELS].sort(), 'os nove read models passaram pelo replay');
});

test('m9d618 erro no meio desfaz a atualização', async () => {
  const target = bi.readModels.getReadModel('rm_project_delays');
  const original = target.recompute;
  const event = bi.makeEvent(env.tenantA, 'construction.project.status_changed', { id: ids.p3 });
  target.recompute = async () => { throw Object.assign(new Error('falha simulada nos atrasos'), { code: 'M9D618_FALHA' }); };
  try {
    await assert.rejects(bi.apply(env.tenantA, event), (e) => e.code === 'M9D618_FALHA');
  } finally { target.recompute = original; }
  for (const m of ['rm_project_progress', 'rm_project_cost', 'rm_project_delays']) {
    assert.equal((await bi.rowsOf(env, m, env.tenantA)).filter((r) => r.project_id === ids.p3).length, 0, `${m}: nada gravado para a obra do evento que falhou`);
  }
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  const ok = await bi.apply(env.tenantA, event);
  assert.equal(ok.upserted, 3, 'sem a falha o mesmo evento é aplicado normalmente nos três');
});
