'use strict';

// M9-D412 — ciclo de vida da campanha: início e fim pelo job, resultado/attainment, steps e encerramento. Postgres real (RLS FORCE),
// transação com rollback, relógio injetado. Rodar SOMENTE em banco descartável (veja m9d412.campanhas.test.js).

const crypto = require('node:crypto');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const campaigns = require('../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../src/features/marketing/campaigns/lifecycle.service');
const { assertCampaignRunning } = require('../src/features/marketing/campaigns/runnerGuard');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../src/features/marketing/campaigns/sendPort');
const { recordApprovedHash } = require('../src/features/marketing/content/approval.guard');
const { insertContent, insertJob } = require('./helpers/m9d404Fixtures');
const { tenants, makePerson, makeTemplate, completeBody, loadCampaign, loadSteps, q, uid, DAY } = require('./helpers/m9d412Fixtures');

let A;
const save = (t, body) => campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const at = (iso, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);
const tick = (t, now) => lifecycle.runLifecycleTick(A, t, now);

before(async () => { ({ a: A } = await tenants()); });
afterEach(() => clearCampaignSendPort());
after(async () => { await sequelize.close(); });

async function scheduled(t, over = {}, people = 1) {
  const templateId = over.templateId || await makeTemplate(t, A);
  const personIds = [];
  for (let i = 0; i < people; i += 1) personIds.push(await makePerson(t, A));
  const body = completeBody({ templateId, personIds, ...over });
  const { campaign } = await save(t, body);
  return { campaign, body, templateId, personIds };
}
const events = (t, id) => q(t, "SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = :id ORDER BY occurred_at, event_type", { id });

test('lifecycle_job_inicia_e_encerra_no_horario', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    // horário sem fuso é horário de Brasília: 09:00 em America/Sao_Paulo = 12:00Z
    const { campaign } = await scheduled(t, { startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' });
    assert.equal(new Date(campaign.startsAt).toISOString(), '2031-12-01T12:00:00.000Z');
    assert.equal(new Date(campaign.endsAt).toISOString(), '2031-12-10T21:00:00.000Z');

    assert.deepEqual(await tick(t, at('2031-12-01T11:59:59Z')).then((r) => r.started), [], 'antes do início nada acontece');
    assert.equal((await loadCampaign(t, campaign.id)).status, 'SCHEDULED');

    const started = await tick(t, at('2031-12-01T12:00:00Z'));
    assert.deepEqual(started.started, [campaign.id]);
    assert.equal((await loadCampaign(t, campaign.id)).status, 'RUNNING');
    assert.deepEqual((await tick(t, at('2031-12-01T12:00:30Z'))).started, [], 'repetir o job não reinicia');
    assert.deepEqual((await tick(t, at('2031-12-10T20:59:59Z'))).ended, []);

    const ended = await tick(t, at('2031-12-10T21:00:00Z'));
    assert.deepEqual(ended.ended, [campaign.id]);
    const row = await loadCampaign(t, campaign.id);
    assert.equal(row.status, 'ENDED');
    assert.ok(row.result_value !== null);
    assert.deepEqual((await tick(t, at('2031-12-11T00:00:00Z'))).ended, [], 'ENDED é final');

    const ev = await events(t, campaign.id);
    assert.deepEqual(ev.map((e) => e.event_type).sort(), ['marketing.campaign.ended', 'marketing.campaign.started']);
    const audits = await q(t, "SELECT action FROM audit.audit_log WHERE entity_id = :id", { id: campaign.id });
    for (const a of ['marketing.campaign.start', 'marketing.campaign.end']) assert.ok(audits.some((x) => x.action === a), a);
  });
});

test('data_sem_fuso_usa_o_fuso_da_empresa_configurado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const { upsertSetting } = require('../src/features/settings/settings.service');
    await upsertSetting('marketing.quiet_hours', '21:00 a 08:00 America/Manaus', A, A.userId, t);
    const { campaign } = await scheduled(t, { startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' });
    assert.equal(new Date(campaign.startsAt).toISOString(), '2031-12-01T13:00:00.000Z', 'Manaus é UTC-4');
    const withZone = await scheduled(t, { startsAt: '2031-12-01T09:00:00-03:00', endsAt: '2031-12-10T18:00:00Z' });
    assert.equal(new Date(withZone.campaign.startsAt).toISOString(), '2031-12-01T12:00:00.000Z', 'o fuso informado vale');
    await assert.rejects(save(t, completeBody({ templateId: await makeTemplate(t, A), personIds: [await makePerson(t, A)], startsAt: '2031-13-45T09:00:00' })),
      (e) => e.statusCode === 400 && e.code === 'MKT_CAMPAIGN_VALIDATION');
  });
});

test('resultado_e_attainment_calculados', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const { campaign, personIds } = await scheduled(t, { objectiveMetric: 'VISITS', targetValue: 40, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' });
    // o custo real vem do Financeiro (M9-D432): despesa paga de R$ 9.180,00 ligada à campanha pela referência de origem
    await require('./marco9/_helpers/m9d432Fixtures').expense(t, A, { amount: 9180, ref: `campaign:${campaign.id}` });
    const ins = (type, when, valid = true, camp = campaign.id) => q(t,
      `INSERT INTO marketing.attribution_events (group_id, company_id, person_id, campaign_id, event_type, touch_roles, evidence_json, valid, occurred_at)
       VALUES (:g, :c, :p, :camp, :ty, '{FIRST,LAST}', '{"fonte":"QA-M9"}'::jsonb, :v, :w) RETURNING id`,
      { g: A.groupId, c: A.companyId, p: personIds[0], camp, ty: type, v: valid, w: when });
    for (let i = 0; i < 34; i += 1) await ins('VISIT', '2031-12-05T12:00:00Z');
    await ins('VISIT', '2031-12-05T12:00:00Z', false); // inválido não conta
    await ins('VISIT', '2031-11-30T12:00:00Z'); // antes do início
    await ins('VISIT', '2031-12-11T12:00:00Z'); // depois do fim
    await ins('LEAD_CREATED', '2031-12-05T12:00:00Z'); // outro tipo
    await ins('VISIT', '2031-12-05T12:00:00Z', true, null); // sem campanha

    await tick(t, at('2031-12-01T12:00:00Z'));
    const { ended } = await tick(t, at('2031-12-10T21:00:00Z'));
    assert.deepEqual(ended, [campaign.id]);
    const got = await campaigns.getCampaign(A, campaign.id, t);
    assert.equal(got.status, 'ENDED');
    assert.equal(got.resultValue, 34);
    assert.equal(got.attainment, 0.85);
    assert.equal(got.attainmentDisplay, '85,00%');
    assert.equal(got.costActual, 9180);
    assert.equal(got.costPerResult, 270);
    const [row] = await q(t, 'SELECT result_value FROM marketing.campaigns WHERE id = :id', { id: campaign.id });
    assert.equal(Number(row.result_value), 34);
    const [ev] = (await events(t, campaign.id)).filter((e) => e.event_type === 'marketing.campaign.ended');
    assert.equal(ev.payload_json.attainment, 0.85);
    assert.equal(ev.payload_json.resultValue, 34);
    // sem resultado: sem custo por resultado (não divide por zero)
    const zero = await scheduled(t, { startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' });
    await tick(t, at('2031-12-10T21:00:00Z'));
    const g2 = await campaigns.getCampaign(A, zero.campaign.id, t);
    assert.equal(g2.resultValue, 0);
    assert.equal(g2.attainment, 0);
    assert.equal(g2.costPerResult, null);
    // campanha ainda não encerrada não tem resultado
    const open = await scheduled(t, {});
    assert.equal((await campaigns.getCampaign(A, open.campaign.id, t)).attainment, null);
  });
});

test('resultado_por_metrica_conta_o_evento_certo', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const metrics = { LEADS: 'LEAD_CREATED', VISITS: 'VISIT', PROPOSALS: 'PROPOSAL', SALES: 'SALE' };
    const counts = { LEAD_CREATED: 1, VISIT: 2, PROPOSAL: 3, SALE: 4 };
    const created = {};
    for (const metric of Object.keys(metrics)) {
      const c = await scheduled(t, { objectiveMetric: metric, targetValue: 10, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' });
      created[metric] = c;
      for (const [type, n] of Object.entries(counts)) {
        for (let i = 0; i < n; i += 1) {
          await q(t, `INSERT INTO marketing.attribution_events (group_id, company_id, person_id, campaign_id, event_type, touch_roles, evidence_json, valid, occurred_at)
            VALUES (:g, :c, :p, :camp, :ty, '{FIRST}', '{"fonte":"QA-M9"}'::jsonb, true, '2031-12-05T12:00:00Z')`,
          { g: A.groupId, c: A.companyId, p: c.personIds[0], camp: c.campaign.id, ty: type });
        }
      }
    }
    await tick(t, at('2031-12-01T12:00:00Z'));
    await tick(t, at('2031-12-10T21:00:00Z'));
    for (const [metric, type] of Object.entries(metrics)) {
      const got = await campaigns.getCampaign(A, created[metric].campaign.id, t);
      assert.equal(got.resultValue, counts[type], `${metric} conta ${type}`);
      assert.equal(got.attainment, counts[type] / 10);
    }
    // REVIEWS e AWARENESS deixaram de ser métrica
    for (const objectiveMetric of ['REVIEWS', 'AWARENESS']) {
      await assert.rejects(save(t, completeBody({ templateId: await makeTemplate(t, A), personIds: [await makePerson(t, A)], objectiveMetric })),
        (e) => e.statusCode === 400 && e.code === 'MKT_CAMPAIGN_VALIDATION');
    }
  });
});

test('campanha_encerrada_steps_nao_continuam', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const sent = [];
    registerCampaignSendPort({ canSend: async () => ({ allowed: true }), send: async (ctx) => { sent.push(ctx.actionKey); return { ok: true }; } });
    const templateId = await makeTemplate(t, A);
    const { itemId, versionId } = await insertContent(t, A, { itemStatus: 'APPROVED' });
    const { campaign } = await scheduled(t, { templateId, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', steps: [
      { channel: 'EMAIL', templateId, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId, offsetMinutes: 60 * 24 * 5 },
    ] });
    await q(t, 'UPDATE marketing.content_items SET campaign_id = :c WHERE id = :i', { c: campaign.id, i: itemId });
    const jobId = await insertJob(t, A, versionId);

    await tick(t, at('2031-12-01T12:00:00Z')); // começa: o 1º step sai
    assert.equal(sent.length, 1);
    assert.deepEqual((await loadSteps(t, campaign.id)).map((s) => s.status), ['SENT', 'SCHEDULED']);
    assert.equal((await assertCampaignRunning(campaign.id, A, t)).allowed, true);

    await tick(t, at('2031-12-10T21:00:00Z')); // termina
    const steps = await loadSteps(t, campaign.id);
    assert.deepEqual(steps.map((s) => s.status), ['SENT', 'CANCELLED'], 'o step já enviado fica; o pendente cancela');
    assert.equal(steps[1].status_reason, 'CAMPAIGN_ENDED');
    const [job] = await q(t, 'SELECT status, last_error_code FROM marketing.publication_jobs WHERE id = :id', { id: jobId });
    assert.deepEqual(job, { status: 'CANCELLED', last_error_code: 'CAMPAIGN_ENDED' });

    const guard = await assertCampaignRunning(campaign.id, A, t);
    assert.deepEqual(guard, { allowed: false, blockCode: 'CAMPAIGN_NOT_RUNNING', status: 'ENDED' });
    // forçar um step pendente em campanha encerrada não dispara nada
    await q(t, "UPDATE marketing.campaign_steps SET status = 'SCHEDULED' WHERE id = :id", { id: steps[1].id });
    const r = await tick(t, at('2031-12-20T00:00:00Z'));
    assert.equal(sent.length, 1, 'o runner recusou a ação');
    assert.ok(r.dispatch.blocked >= 0);
    // campanha inexistente também é bloqueada
    assert.equal((await assertCampaignRunning(uid(), A, t)).allowed, false);
  });
});

test('step_planned_vira_scheduled_e_skipped_quando_conteudo_perde_aprovacao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const calls = [];
    registerCampaignSendPort({
      canSend: async () => ({ allowed: true }),
      send: async (ctx) => { calls.push(ctx); return { ok: true, externalRef: 'msg-1' }; },
    });
    const tplOk = await makeTemplate(t, A);
    const tplGone = await makeTemplate(t, A);
    const good = await insertContent(t, A, { itemStatus: 'APPROVED' });
    await recordApprovedHash(A, A.userId, good.versionId, t);
    const bad = await insertContent(t, A, { itemStatus: 'APPROVED' }); // versão sem approved_hash: aprovação não vale
    const people = [await makePerson(t, A), await makePerson(t, A)];
    const body = completeBody({ templateId: tplOk, personIds: people, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', steps: [
      { channel: 'EMAIL', templateId: tplOk, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId: tplOk, contentItemId: good.itemId, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId: tplOk, contentItemId: bad.itemId, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId: tplGone, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId: tplOk, offsetMinutes: 120 },
    ] });
    const { campaign } = await save(t, body);
    assert.deepEqual((await loadSteps(t, campaign.id)).map((s) => s.status), Array(5).fill('SCHEDULED'), 'PLANNED vira SCHEDULED ao agendar');

    await q(t, "UPDATE marketing.templates SET status = 'RETIRED' WHERE id = :id", { id: tplGone });
    await tick(t, at('2031-12-01T12:00:00Z', 1000));
    const steps = await loadSteps(t, campaign.id);
    assert.deepEqual(steps.map((s) => s.status), ['SENT', 'SENT', 'SKIPPED', 'SKIPPED', 'SCHEDULED']);
    assert.equal(steps[2].status_reason, 'APPROVAL_INVALID');
    assert.equal(steps[3].status_reason, 'TEMPLATE_NOT_APPROVED');
    const [item] = await q(t, 'SELECT status FROM marketing.content_items WHERE id = :id', { id: bad.itemId });
    assert.equal(item.status, 'PENDING_APPROVAL', 'a invalidação da aprovação foi aplicada');
    assert.equal(calls.length, 4, '2 steps x 2 destinatários');
    const key = sha(`${campaign.id}:${steps[0].id}:${people[0]}`);
    const deliveries = await q(t, 'SELECT action_key, status FROM marketing.campaign_step_deliveries WHERE step_id = :s ORDER BY action_key', { s: steps[0].id });
    assert.ok(deliveries.some((d) => d.action_key === key && d.status === 'SENT'));

    // o job repetido não reenvia (idempotência por action_key)
    await tick(t, at('2031-12-01T12:00:00Z', 5000));
    assert.equal(calls.length, 4);
    // offset: 120 min depois do início o último step sai
    await tick(t, at('2031-12-01T12:00:00Z', 119 * 60000));
    assert.equal((await loadSteps(t, campaign.id))[4].status, 'SCHEDULED');
    await tick(t, at('2031-12-01T12:00:00Z', 121 * 60000));
    assert.equal((await loadSteps(t, campaign.id))[4].status, 'SENT');
    assert.equal(calls.length, 6);
  });
});

test('step_sem_destinatario_permitido_vira_skipped_e_sem_porta_nao_dispara', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const { campaign, personIds } = await scheduled(t, { startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' }, 2);
    // sem porta de envio registrada (D418/D429): o step continua SCHEDULED, nada é marcado como enviado
    const deferred = await tick(t, at('2031-12-01T12:00:10Z'));
    assert.equal(deferred.dispatch.deferred, 1);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SCHEDULED');
    // todos bloqueados pelo canSend: SKIPPED, e os bloqueios ficam registrados
    registerCampaignSendPort({ canSend: async () => ({ allowed: false, reason: 'SUPPRESSED' }), send: async () => { throw new Error('não deveria enviar'); } });
    await tick(t, at('2031-12-01T12:01:00Z'));
    const [step] = await loadSteps(t, campaign.id);
    assert.equal(step.status, 'SKIPPED');
    assert.equal(step.status_reason, 'NO_ALLOWED_RECIPIENT');
    const rows = await q(t, 'SELECT status, reason FROM marketing.campaign_step_deliveries WHERE step_id = :s', { s: step.id });
    assert.deepEqual(rows.map((r) => `${r.status}:${r.reason}`), ['BLOCKED:SUPPRESSED', 'BLOCKED:SUPPRESSED']);
    assert.equal(personIds.length, 2);
  });
});

test('lote_de_destinatarios_por_ciclo_e_configuravel', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const { upsertSetting } = require('../src/features/settings/settings.service');
    await upsertSetting('marketing.campanhas.lote_destinatarios', 2, A, A.userId, t);
    let n = 0;
    registerCampaignSendPort({ canSend: async () => ({ allowed: true }), send: async () => { n += 1; return { ok: true }; } });
    const { campaign } = await scheduled(t, { startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00' }, 5);
    await tick(t, at('2031-12-01T12:00:10Z'));
    assert.equal(n, 2);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SCHEDULED', 'ainda há destinatários');
    await tick(t, at('2031-12-01T12:01:10Z'));
    await tick(t, at('2031-12-01T12:02:10Z'));
    assert.equal(n, 5);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT');
    assert.ok(DAY > 0);
  });
});
