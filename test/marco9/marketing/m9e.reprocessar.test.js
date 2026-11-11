'use strict';

// Verificação K=7 do e-mail de campanha, itens 5 e 14: o caminho AUDITADO para as entregas que ficaram FAILED por falha transitória antes da correção
// (campanha cfc5c8e1 da homologação: FAILED MKT_UNSUBSCRIBE_KEY_UNAVAILABLE com o cofre fora). As linhas "legadas" são reproduzidas como o código antigo as
// gravava (FAILED, sem hora de voltar, step já SENT). Banco descartável, RLS real, transação com rollback.
const env = require('../_helpers/m9eEnv');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { reprocessDeliveries } = require('../../../src/features/marketing/campaigns/delivery/reprocess.service');
const { clearCampaignSendPort, registerCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');

const { q, readyPerson, campaignFor, tick, one, messagesOf, sent, setParam, audits, stepOf, at, T0, scenario, rejectsWith } = env;
let A; let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
beforeEach(() => env.setUp());
afterEach(() => env.tearDown());
after(async () => { await sequelize.close(); });

const MOTIVO = 'Cofre configurado; reenvio das entregas que falharam sem cofre';

/** Deixa a entrega como o código antigo (41addaa2) a gravava: FAILED com o motivo, sem hora de voltar, e o step fechado como SENT. */
async function legacyFailed(t, campaignId, reason) {
  await q(t, "UPDATE marketing.campaign_step_deliveries SET status = 'FAILED', reason = :r, next_attempt_at = NULL WHERE campaign_id = :c RETURNING id", { c: campaignId, r: reason });
  await q(t, "UPDATE marketing.campaign_steps SET status = 'SENT', status_reason = NULL WHERE campaign_id = :c RETURNING id", { c: campaignId });
}

test('entrega_FAILED_pelo_cofre_fora_volta_a_fila_com_auditoria_e_sai_no_ciclo_seguinte', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    env.vaultDown();
    await tick(t, A, T0);
    await legacyFailed(t, c.id, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE'); // o estado da cfc5c8e1 na homologação
    env.vaultBack();
    await tick(t, A, at(60));
    assert.equal((await one(t, c.id)).status, 'FAILED', 'sem a ação do administrador o FAILED legado não volta sozinho');

    const out = await reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(120) });
    assert.deepEqual([out.reprocessed, out.asRetry, out.asUnknown, out.stepsReopened], [1, 1, 0, 1]);
    const d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.attempts], ['RETRY', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 0]);
    assert.equal((await stepOf(t, c.id)).status, 'SCHEDULED', 'o step fechado volta a SCHEDULED');
    assert.equal(sent(A), 0, 'a ação não envia nada; quem envia é o ciclo da campanha');

    const [geral] = await audits(t, A, 'marketing.campaign.deliveries.reprocess', c.id);
    assert.equal(geral.user_id, A.userId); assert.equal(geral.reason, MOTIVO);
    assert.deepEqual(geral.before_json.deliveries.map((x) => [x.status, x.reason]), [['FAILED', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE']]);
    assert.equal(geral.after_json.reprocessed, 1);
    const [porEntrega] = await audits(t, A, 'marketing.campaign.delivery.reprocessed', d.id);
    assert.deepEqual([porEntrega.before_json.status, porEntrega.after_json.status, porEntrega.user_id], ['FAILED', 'RETRY', A.userId]);
    assert.equal((await audits(t, A, 'marketing.campaign.step.reopened')).length, 1);

    await tick(t, A, at(180));
    assert.equal((await one(t, c.id)).status, 'SENT');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['SENT']);
    assert.equal((await stepOf(t, c.id)).status, 'SENT');
    assert.equal(sent(A), 1);
    const again = await reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(240) });
    assert.equal(again.reprocessed, 0, 'repetir não reabre o que já saiu');
  });
});

test('FAILED_legado_de_timeout_volta_como_UNKNOWN_e_reconcilia_antes_de_qualquer_reenvio', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    await tick(t, A, T0);
    scenario.current = null;
    await legacyFailed(t, c.id, 'CHANNEL_UNKNOWN');
    const out = await reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(60) });
    assert.deepEqual([out.asUnknown, out.asRetry], [1, 0]);
    await tick(t, A, at(61));
    assert.equal((await one(t, c.id)).status, 'SENT', 'o provedor tinha o e-mail: marcado SENT');
    assert.equal(sent(A), 1, 'sem duplicar');
  });
});

test('FAILED_por_tentativas_esgotadas_reabre_a_mensagem_do_crm_e_sai', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.retry.max_attempts', 1);
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'HTTP_5XX';
    await tick(t, A, T0);
    assert.equal((await one(t, c.id)).reason, 'MKT_DELIVERY_RETRIES_EXHAUSTED');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['FAILED']);
    scenario.current = null;
    await reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(60) });
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['QUEUED'], 'a mensagem fechada volta à fila');
    await tick(t, A, at(61));
    assert.equal((await one(t, c.id)).status, 'SENT');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['SENT'], 'a mesma mensagem, a mesma chave');
    assert.equal(sent(A), 1);
  });
});

test('recusa_definitiva_bloqueio_e_opt_out_posterior_nao_recebem', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ok = await readyPerson(t, A);
    const semConsent = await readyPerson(t, A, { optIn: [] });
    const c = await campaignFor(t, A, [ok, semConsent]);
    scenario.current = 'REJECTED';
    await tick(t, A, T0);
    scenario.current = null;
    const out = await reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(60) });
    assert.equal(out.reprocessed, 0, 'FAILED REJECTED e BLOCKED NO_CONSENT ficam como estão');

    const p = await readyPerson(t, A);
    const c2 = await campaignFor(t, A, [p]);
    env.vaultDown();
    await tick(t, A, at(70));
    env.vaultBack();
    await legacyFailed(t, c2.id, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE');
    await env.addConsent(t, A, p, 'EMAIL', 'MARKETING', 'OPT_OUT', at(80));
    await reprocessDeliveries(A, A.userId, c2.id, { reason: MOTIVO }, t, { now: at(90) });
    await tick(t, A, at(91));
    assert.deepEqual([(await one(t, c2.id)).status, (await one(t, c2.id)).reason], ['BLOCKED', 'OPT_OUT'], 'o canSend é avaliado na hora do reenvio');
    assert.equal(sent(A), 0);
  });
});

test('recusas_motivo_curto_campanha_encerrada_ou_nao_iniciada_outra_empresa_e_envio_desligado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    await rejectsWith(assert, reprocessDeliveries(A, A.userId, c.id, { reason: 'curto' }, t, { now: at(0) }), 400, 'MKT_CAMPAIGN_VALIDATION');
    await rejectsWith(assert, reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO, stepId: 'x' }, t, { now: at(0) }), 400, 'MKT_CAMPAIGN_VALIDATION');
    await rejectsWith(assert, reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(0) }), 409, 'MKT_CAMPAIGN_NOT_RUNNING'); // ainda SCHEDULED
    await rejectsWith(assert, reprocessDeliveries(B, B.userId, c.id, { reason: MOTIVO }, t, { now: at(0) }), 404, 'MKT_NOT_FOUND');
    await tick(t, A, T0);
    clearCampaignSendPort();
    await rejectsWith(assert, reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: at(10) }), 503, 'MKT_CAMPAIGN_SEND_UNAVAILABLE');
    registerCampaignSendPort(env.messaging.buildMessagingCampaignPort());
    await tick(t, A, new Date('2031-12-10T21:01:00Z'));
    await rejectsWith(assert, reprocessDeliveries(A, A.userId, c.id, { reason: MOTIVO }, t, { now: new Date('2031-12-10T21:02:00Z') }), 409, 'MKT_CAMPAIGN_FINAL');
  });
});
