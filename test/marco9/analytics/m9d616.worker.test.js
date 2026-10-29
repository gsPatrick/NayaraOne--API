'use strict';

// M9-D616 — o worker do BI (M9-D607) e o rebuild (M9-D608) aplicados aos read models de Comercial/CRM e Imóveis: replay, rebuild, carimbos de tempo,
// isolamento entre empresas, atomicidade e agenda. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');
const asserts = require('../_helpers/readModelAsserts');
const { seed, iso } = require('../_helpers/biSeed616');
const readModels = require('../../../src/features/analytics/read-models');
const clock = require('../../../src/features/analytics/metrics/clock');

const { src, apply, makeEvent, rows, pick, runSchedule, inTx } = bi;
const MODELS = ['rm_crm_lead_daily', 'rm_crm_opportunity_stage', 'rm_crm_outcome', 'rm_crm_next_action', 'rm_crm_visits_proposals', 'rm_property_portfolio', 'rm_property_price_changes', 'rm_radar_matches', 'rm_broker_performance'];
let env;
let events;
before(async () => { env = await bi.setup(); events = await seed(env, env.cX); });
after(() => bi.teardown(env));

const all = async (tenant) => (await Promise.all(MODELS.map((m) => rows(env, m, tenant)))).flat();
const ctxFor = (tenant) => ({ groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason: 'Teste: tabela apagada e reconstruída da fonte.' });

test('m9d616 replay do mesmo evento não duplica', async () => {
  const event = events[0];
  const { first } = await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.cX, event), readRow: () => all(env.cX) });
  assert.ok(first.upserted >= 3, 'o evento da oportunidade atualiza vários read models');
});

test('m9d616 rebuild reproduz o incremental', async (t) => {
  clock.setClock(() => bi.NOW); // dias parados (M9-D631) dependem do dia: incremental e rebuild medem no mesmo instante
  t.after(() => clock.resetClock());
  for (const event of events) await apply(env.cX, event);
  for (const model of MODELS) {
    process.stdout.write(`# rebuild ${model}\n`);
    const hash = await asserts.assertRebuildEqualsIncremental({ // o nome do modelo aparece no erro abaixo, se houver diferença
      buildIncremental: async () => {},
      readRows: () => rows(env, model, env.cX),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: env.cX.companyId } }),
      rebuild: async () => { const r = await readModels.rebuildReadModel(ctxFor(env.cX), { model, companyId: env.cX.companyId }); assert.equal(r.status, 'SUCCEEDED', model); },
    });
    assert.match(hash, /^[0-9a-f]{64}$/, model);
    assert.ok((await rows(env, model, env.cX)).length > 0, `${model}: o rebuild devolveu linhas`);
  }
});

test('m9d616 source_snapshot_at e refreshed_at gravados', async () => {
  for (const model of MODELS) {
    const list = await rows(env, model, env.cX);
    assert.ok(list.length > 0, model);
    for (const r of list) {
      assert.ok(r.refreshed_at, `${model}: refreshed_at`);
      assert.ok(r.source_snapshot_at, `${model}: source_snapshot_at`);
      assert.equal(r.version, 1, `${model}: version`);
    }
  }
  assert.equal(new Date(pick(await rows(env, 'rm_crm_next_action', env.cX), {}).source_snapshot_at).getTime() > 0, true);
});

test('m9d616 isolamento entre empresas', async () => {
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

test('m9d616 erro no meio desfaz a atualização', async () => {
  const o = await src.opportunity(env, env.cX, { owner: src.uuid(), source: 'ATOMICO', created: iso('2026-10-22') });
  const event = makeEvent(env.cX, 'crm.opportunity.created', { id: o });
  const before = await all(env.cX);
  const model = readModels.getReadModel('rm_crm_next_action');
  const original = model.recompute;
  model.recompute = async () => { throw Object.assign(new Error('falha simulada na carteira'), { code: 'M9D616_FALHA' }); };
  try {
    await assert.rejects(apply(env.cX, event), (e) => e.code === 'M9D616_FALHA');
  } finally { model.recompute = original; }
  assert.deepEqual(await all(env.cX), before, 'os read models aplicados antes da falha também foram desfeitos');
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.ok((await apply(env.cX, event)).upserted >= 3, 'sem a falha o mesmo evento é aplicado');
});

test('m9d616 agenda recalcula o que depende do relógio', async () => {
  const b = src.uuid();
  await src.visit(env, env.cX, { at: iso('2026-10-27'), status: 'SCHEDULED' }); // visita agendada não publica evento
  await src.opportunity(env, env.cX, { owner: b, stage: 'NEW', created: iso('2026-10-26'), updated: iso('2026-10-26') });
  const prop = await src.property(env, env.cX, { publishedAt: iso('2026-10-20'), created: iso('2026-10-01') });
  await apply(env.cX, makeEvent(env.cX, 'property.created', { id: prop }));
  await runSchedule(env.cX); // 28/10
  assert.ok((pick(await rows(env, 'rm_crm_visits_proposals', env.cX, '1'), { day: '2026-10-27' })).visits_scheduled >= 1, 'a visita agendada entrou pela agenda, sem nenhum evento');
  const stage = () => rows(env, 'rm_crm_opportunity_stage', env.cX).then((l) => pick(l, { stage: 'NEW', broker_id: b }));
  assert.equal((await stage()).stalled_count, 0, 'em 28/10 a oportunidade de 26/10 ainda não está parada');
  const bucket = async () => (await rows(env, 'rm_property_portfolio', env.cX)).filter((r) => r.status === 'AVAILABLE').map((r) => r.no_sale_days_bucket).sort().join();
  assert.match(await bucket(), /ATE_30/);
  await runSchedule(env.cX, new Date('2026-12-10T15:00:00Z')); // só o tempo passou
  assert.equal((await stage()).stalled_count, 1, 'sem nenhum evento a oportunidade passou a parada');
  assert.match(await bucket(), /31_A_90/, 'a faixa de dias sem venda andou com o relógio');
  const [refresh] = (await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_crm_opportunity_stage' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: env.cX.companyId } }))[0];
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
});
