'use strict';

// M9-D628 — replay do mesmo evento e atomicidade: o helper compartilhado assertReplayIdempotent (M9-D607) sobre os read models que têm evento, e a passada
// agendada repetida no mesmo instante (os que não têm evento) sem alterar nada. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d628Scenario');

let env;
let ids;
before(async () => {
  env = await env628.setup();
  ids = await sc.seedAll(env, env.tenantA);
});
after(() => env628.teardown(env));

test('m9d628 replay do mesmo evento não duplica', async () => {
  const covered = new Set();
  for (const [type, payload, models] of sc.eventsOf(ids)) {
    const event = env628.makeEvent(env.tenantA, type, payload);
    const snapshot = async () => Object.fromEntries(await Promise.all(models.map(async (m) => [m, await env628.rowsOf(env, m, env.tenantA)])));
    const { first, before: rows } = await asserts.assertReplayIdempotent({ applyEvent: () => env628.apply(env.tenantA, event), readRow: snapshot });
    assert.ok(first.upserted >= models.length, `${type} aplicou em ${models.join(', ')}`);
    for (const m of models) { assert.ok(rows[m].length >= 1, `${m} tem linha`); covered.add(m); }
  }
  assert.deepEqual([...covered].sort(), ['rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls', 'rm_tech_blocked_events', 'rm_tech_integrations']);
});

test('m9d628 a passada agendada repetida no mesmo instante não altera os read models sem evento', async () => {
  const names = ['rm_tech_availability', 'rm_tech_queues', 'rm_tech_auth_failures']; // o freshness reflete o histórico de atualizações, que a própria passada acrescenta
  await env628.runSchedule(env.tenantA, env628.NOW);
  const first = Object.fromEntries(await Promise.all(names.map(async (m) => [m, await env628.content(env, m, env.tenantA)])));
  assert.ok(names.every((m) => first[m].length >= 1), 'os três têm linha');
  await env628.runSchedule(env.tenantA, env628.NOW);
  for (const m of names) assert.deepEqual(await env628.content(env, m, env.tenantA), first[m], m);
});

test('m9d628 erro no meio desfaz a atualização', async () => {
  const target = env628.readModels.getReadModel('rm_ai_tool_calls'); // o último dos três que o evento de execução atualiza
  const original = target.recompute;
  const event = env628.makeEvent(env.tenantA, 'ai.run.completed', { id: ids.runs.r2, runId: ids.runs.r2 });
  await env.admin.query('DELETE FROM analytics.rm_ai_cost WHERE company_id = :c', { replacements: { c: env.tenantA.companyId } });
  target.recompute = async () => { throw Object.assign(new Error('falha simulada nas chamadas de ferramenta'), { code: 'M9D628_FALHA' }); };
  try {
    await assert.rejects(env628.apply(env.tenantA, event), (e) => e.code === 'M9D628_FALHA');
  } finally { target.recompute = original; }
  assert.equal((await env628.rowsOf(env, 'rm_ai_cost', env.tenantA)).length, 0, 'o custo, aplicado antes da falha, também foi desfeito');
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.equal((await env628.apply(env.tenantA, event)).upserted, 3, 'sem a falha o mesmo evento é aplicado normalmente nos três');
  assert.equal((await env628.rowsOf(env, 'rm_ai_cost', env.tenantA)).length, 2);
});
