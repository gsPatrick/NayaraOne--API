'use strict';

// M9-D627 — o worker do BI (M9-D607) e o rebuild (M9-D608) aplicados aos read models de Marketing e Atendimento: replay, rebuild, carimbos de
// tempo, isolamento, atomicidade e agenda.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env627 = require('../_helpers/m9d627Env');
const scenario = require('../_helpers/m9d627Scenario');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');

const { src, makeEvent, apply, schedule, rowOf, rowsOf, rebuildCtx, at, NOW, readModels } = env627;
let env;
before(async () => { env = await env627.setup(); clock.setClock(() => NOW); });
after(async () => { clock.resetClock(); await env627.teardown(env); });

const campaignEvent = (tenant, campaignId, when = NOW) => makeEvent(tenant, 'marketing.campaign.started', { campaignId, startsAt: '2026-10-01T00:00:00Z' }, when);

test('m9d627 replay do mesmo evento não duplica', async () => {
  const campaignId = await src.campaign(env, env.tenantA, { cost: '3200.00' });
  const event = campaignEvent(env.tenantA, campaignId);
  const { before: row } = await asserts.assertReplayIdempotent({
    applyEvent: () => apply(env.tenantA, event),
    readRow: () => rowOf(env, 'rm_mkt_campaigns', env.tenantA, { campaign_id: campaignId }),
  });
  assert.equal(row.cost_total, '3200.00');
  assert.equal((await rowsOf(env, 'rm_mkt_campaigns', env.tenantA)).filter((r) => r.campaign_id === campaignId).length, 1);
});

test('m9d627 rebuild reproduz o incremental', async () => {
  const t = env.tenantB;
  const events = await scenario.seed(env, t);
  for (const event of events) await apply(t, event);
  await schedule(t); // o que só a agenda descobre: plataforma da avaliação, falha de run, meses de prazo dos casos em aberto
  for (const model of src.MODELS) {
    const rows = await rowsOf(env, model, t);
    assert.ok(rows.length > 0, `${model}: o incremental gerou linhas`);
    const hash = await asserts.assertRebuildEqualsIncremental({
      buildIncremental: async () => {},
      readRows: () => rowsOf(env, model, t),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: t.companyId } }),
      rebuild: async () => { await readModels.rebuildReadModel(rebuildCtx(t), { model, companyId: t.companyId }); },
    });
    assert.match(hash, /^[0-9a-f]{64}$/, model);
  }
});

test('m9d627 source_snapshot_at e refreshed_at gravados', async () => {
  const campaignId = await src.campaign(env, env.tenantA, { cost: '10.00' });
  await apply(env.tenantA, campaignEvent(env.tenantA, campaignId, at('2026-10-28', 14)));
  const row = await rowOf(env, 'rm_mkt_campaigns', env.tenantA, { campaign_id: campaignId });
  assert.equal(new Date(row.source_snapshot_at).toISOString(), '2026-10-28T14:00:00.000Z', 'instante da fotografia da fonte (o do evento)');
  assert.ok(row.refreshed_at, 'refreshed_at gravado');
  assert.equal(row.version, 1);
  assert.equal(row.group_id, env.tenantA.groupId);
});

test('m9d627 isolamento entre empresas', async () => {
  const campaignB = await src.campaign(env, env.tenantB, { cost: '999.99' });
  const beforeA = await rowsOf(env, 'rm_mkt_campaigns', env.tenantA);
  await apply(env.tenantB, campaignEvent(env.tenantB, campaignB));
  assert.deepEqual(await rowsOf(env, 'rm_mkt_campaigns', env.tenantA), beforeA, 'só o read model de B muda');
  assert.equal((await rowOf(env, 'rm_mkt_campaigns', env.tenantB, { campaign_id: campaignB })).cost_total, '999.99');
  await env627.inTx(env.tenantA, {}, async (tx) => {
    const [rows] = await tx.sequelize.query('SELECT company_id FROM analytics.rm_mkt_campaigns', { transaction: tx });
    assert.ok(rows.length > 0 && rows.every((r) => r.company_id === env.tenantA.companyId), 'sob o RLS de A só aparecem linhas de A');
  });
  await env627.inTx(env.tenantB, {}, async (tx) => {
    const [rows] = await tx.sequelize.query('SELECT 1 FROM analytics.rm_mkt_campaigns WHERE company_id = :a', { replacements: { a: env.tenantA.companyId }, transaction: tx });
    assert.equal(rows.length, 0);
  });
});

test('m9d627 erro no meio desfaz a atualização', async () => {
  const t = env.tenantA;
  await src.feedbackCase(env, t, { type: 'COMPLAINT', at: at('2026-06-10'), slaDueAt: at('2026-06-13') });
  const event = makeEvent(t, 'crm.feedback_case.created', { id: src.uuid(), type: 'COMPLAINT', severity: 'LOW', slaDueAt: at('2026-06-13').toISOString() }, at('2026-06-10'));
  const sla = readModels.getReadModel('rm_support_sla');
  const original = sla.recompute;
  sla.recompute = async () => { throw Object.assign(new Error('falha simulada no SLA'), { code: 'M9D627_FALHA' }); };
  try {
    await assert.rejects(apply(t, event), (e) => e.code === 'M9D627_FALHA');
  } finally { sla.recompute = original; }
  assert.equal(await rowOf(env, 'rm_support_complaints', t, { month: '2026-06', reason: 'COMPLAINT' }), null, 'as reclamações, aplicadas antes da falha, também foram desfeitas');
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.ok((await apply(t, event)).upserted >= 3, 'sem a falha o mesmo evento é aplicado em todos os read models que o assinam');
  for (const model of ['rm_support_complaints', 'rm_support_sla', 'rm_support_satisfaction']) assert.ok(await rowOf(env, model, t, { month: '2026-06' }), model);
});

test('m9d627 agenda recalcula o que depende do relógio', async () => {
  const t = env.tenantA;
  const messageId = await src.message(env, t, { channel: 'SMS', status: 'SENT', at: at('2026-10-27') });
  const caseId = await src.feedbackCase(env, t, { status: 'OPEN', at: at('2026-10-27'), slaDueAt: at('2026-12-03') }); // prazo = abertura + 72 h (prioridade média, M9-D672) = 30/10 12:00 SP
  const overdue = async () => (await rowOf(env, 'rm_support_sla', t, { month: '2026-10' }) || { open_overdue: 0 }).open_overdue;
  await schedule(t, NOW);
  const base = await overdue();
  assert.equal((await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-27', channel: 'SMS' })).delivered, 0);
  await src.update(env, 'crm.messages', messageId, { status: 'DELIVERED' }); // o status de entrega chega sem evento
  await schedule(t, new Date('2026-12-05T15:00:00Z')); // e o prazo do caso passa
  assert.equal((await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-27', channel: 'SMS' })).delivered, 0, 'fora da janela de 7 dias a agenda não reconfere o dia antigo');
  assert.equal(await overdue(), base + 1, 'o caso em aberto que passou do prazo entra como vencido, sem evento');
  await schedule(t, new Date('2026-10-30T15:00:00Z'));
  assert.equal((await rowOf(env, 'rm_mkt_delivery', t, { day: '2026-10-27', channel: 'SMS' })).delivered, 1, 'dentro da janela, a agenda reconfere o dia e vê o status de entrega');
  await src.update(env, 'crm.feedback_cases', caseId, { status: 'RESOLVED', resolved_at: new Date('2026-12-06T12:00:00Z') });
  await schedule(t, new Date('2026-12-07T15:00:00Z'));
  assert.equal(await overdue(), base, 'resolvido sai dos vencidos');
  const [[refresh]] = await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_support_sla' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: t.companyId } });
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
});
