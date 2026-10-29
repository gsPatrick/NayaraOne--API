'use strict';

// M9-D617 — o worker do BI (M9-D607) e o rebuild (M9-D608) aplicados aos read models de Locação: replay, rebuild, carimbos de tempo, isolamento
// entre empresas, atomicidade e agenda (o tempo passando muda vacância, garantias e inadimplência sem nenhum evento). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');
const asserts = require('../_helpers/readModelAsserts');
const { seed, iso } = require('../_helpers/biSeed617');
const readModels = require('../../../src/features/analytics/read-models');
const clock = require('../../../src/features/analytics/metrics/clock');

const { src, apply, makeEvent, rows, runSchedule, inTx } = bi;
const MODELS = ['rm_rental_contracts', 'rm_rental_vacancy', 'rm_rental_arrears', 'rm_rental_guarantees', 'rm_rental_obligations', 'rm_rental_inspections_keys', 'rm_rental_tickets', 'rm_rental_satisfaction', 'rm_rental_repasses'];
let env;
let events;
before(async () => { env = await bi.setup(); events = await seed(env, env.cX); });
after(() => bi.teardown(env));

const all = async (tenant) => (await Promise.all(MODELS.map((m) => rows(env, m, tenant)))).flat();
const ctxFor = (tenant) => ({ groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason: 'Teste: tabela apagada e reconstruída da fonte.' });

test('m9d617 replay do mesmo evento não duplica', async () => {
  const event = events[0];
  const { first } = await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.cX, event), readRow: () => all(env.cX) });
  assert.ok(first.upserted >= 4, 'o evento do contrato atualiza vários read models');
});

test('m9d617 rebuild reproduz o incremental', async (t) => {
  clock.setClock(() => bi.NOW); // o rebuild recalcula na data-base do relógio do BI
  t.after(() => clock.resetClock());
  for (const event of events) await apply(env.cX, event);
  for (const model of MODELS) {
    const hash = await asserts.assertRebuildEqualsIncremental({
      buildIncremental: async () => {},
      readRows: () => rows(env, model, env.cX),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: env.cX.companyId } }),
      rebuild: async () => { const r = await readModels.rebuildReadModel(ctxFor(env.cX), { model, companyId: env.cX.companyId }); assert.equal(r.status, 'SUCCEEDED', model); },
    });
    assert.match(hash, /^[0-9a-f]{64}$/, model);
    assert.ok((await rows(env, model, env.cX)).length > 0, `${model}: o rebuild devolveu linhas`);
  }
});

test('m9d617 source_snapshot_at, refreshed_at e version gravados', async () => {
  for (const model of MODELS) {
    const list = await rows(env, model, env.cX);
    assert.ok(list.length > 0, model);
    for (const r of list) {
      assert.equal(new Date(r.source_snapshot_at).toISOString(), bi.NOW.toISOString(), `${model}: instante da fotografia da fonte`);
      assert.ok(r.refreshed_at, `${model}: refreshed_at`);
      assert.equal(r.version, 1, `${model}: version`);
    }
  }
});

test('m9d617 isolamento entre empresas', async () => {
  const before = await all(env.cX);
  for (const event of await seed(env, env.cY)) await apply(env.cY, event);
  assert.deepEqual(await all(env.cX), before, 'só o read model da empresa Y mudou');
  assert.ok((await all(env.cY)).length > 0);
  await inTx(env.cX, {}, async (tx) => {
    for (const model of MODELS) {
      const [list] = await tx.sequelize.query(`SELECT DISTINCT company_id FROM analytics.${model}`, { transaction: tx });
      assert.ok(list.every((r) => r.company_id === env.cX.companyId), `${model}: sob o RLS de X só aparecem linhas de X`);
    }
  });
});

test('m9d617 erro no meio desfaz a atualização', async () => {
  const contract = await src.contract(env, env.cX, { status: 'ACTIVE', value: '999.00' });
  const event = makeEvent(env.cX, 'legal.contract.status_changed', { id: contract });
  const before = await all(env.cX);
  const model = readModels.getReadModel('rm_rental_obligations');
  const original = model.recompute;
  model.recompute = async () => { throw Object.assign(new Error('falha simulada nas obrigações'), { code: 'M9D617_FALHA' }); };
  try {
    await assert.rejects(apply(env.cX, event), (e) => e.code === 'M9D617_FALHA');
  } finally { model.recompute = original; }
  assert.deepEqual(await all(env.cX), before, 'os read models aplicados antes da falha também foram desfeitos');
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.ok((await apply(env.cX, event)).upserted >= 4, 'sem a falha o mesmo evento é aplicado');
});

test('m9d617 agenda recalcula o que depende do relógio', async () => {
  const one = async (model, column) => (await rows(env, model, env.cX)).reduce((acc, r) => acc + Number(r[column]), 0);
  await runSchedule(env.cX);
  const guarantee = await one('rm_rental_guarantees', 'expiring_30d');
  const overdue = await one('rm_rental_arrears', 'overdue_count');
  const vacantDays = await one('rm_rental_vacancy', 'vacant_days_sum');
  assert.ok(guarantee >= 1, 'a garantia de 05/11 vence em até 30 dias');
  await runSchedule(env.cX, new Date('2026-12-10T15:00:00Z')); // só o tempo passou, nenhum evento
  assert.equal(await one('rm_rental_guarantees', 'expired') >= 1, true, 'em 10/12 a garantia já venceu');
  assert.equal(await one('rm_rental_guarantees', 'expiring_30d'), 0);
  const [vac] = (await rows(env, 'rm_rental_vacancy', env.cX)).filter((r) => r.as_of_date === '2026-12-10');
  assert.ok(Number(vac.vacant_days_sum) > vacantDays, 'a vacância em dias andou com o relógio');
  const [arr] = (await rows(env, 'rm_rental_arrears', env.cX)).filter((r) => r.as_of_date === '2026-12-10');
  assert.ok(Number(arr.overdue_count) >= overdue);
  const [refresh] = (await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_rental_guarantees' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: env.cX.companyId } }))[0];
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
  assert.ok(iso('2026-12-10'));
});
