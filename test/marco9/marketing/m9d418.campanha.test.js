'use strict';

// M9-D418 (transferido da M9-D412) — o step de campanha dispara por canSend avaliado na hora do envio e termina em SENT, BLOCKED
// (motivo do canSend) ou FAILED, com action_key sha256. O adapter real do canal é da M9-D429; aqui `send` é o adapter simulado.
// Banco descartável (ver m9d416.cap.test.js); transação com rollback.

const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { buildCampaignSendPort } = require('../../../src/features/marketing/suppression/campaignPort');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const env = require('../_helpers/mktPolicyEnv');

const { readyPerson, makeTemplate, completeBody, loadSteps, q } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
afterEach(() => clearCampaignSendPort());
after(async () => { await sequelize.close(); });
const START = '2031-12-01T09:00:00';
const TICK = new Date('2031-12-01T12:00:10Z'); // 09:00:10 em São Paulo, fora do silêncio

async function scheduleFor(t, personIds, purpose = 'MARKETING') {
  const templateId = await makeTemplate(t, A);
  const body = completeBody({ templateId, personIds, startsAt: START, endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose, filter: { personIds } }] });
  const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  return campaign;
}
const deliveries = (t, campaignId) => q(t, 'SELECT person_id, status, reason, action_key, external_ref FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaignId });

test('step_de_campanha_dispara_por_cansend_e_termina_em_sent_blocked_ou_failed', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ok = await readyPerson(t, A);
    const suppressed = await readyPerson(t, A);
    const noConsent = await readyPerson(t, A, { optIn: [] });
    const failing = await readyPerson(t, A);
    await suppress({ personId: suppressed, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    const sentTo = [];
    registerCampaignSendPort(buildCampaignSendPort({
      send: async (ctx) => {
        sentTo.push(ctx.personId);
        return ctx.personId === failing ? { ok: false, errorCode: 'PROVIDER_REJECTED' } : { ok: true, externalRef: `msg-${sentTo.length}` };
      },
    }));
    const campaign = await scheduleFor(t, [ok, suppressed, noConsent, failing]);
    await lifecycle.runLifecycleTick(A, t, TICK);
    const byPerson = Object.fromEntries((await deliveries(t, campaign.id)).map((d) => [d.person_id, d]));
    assert.deepEqual([byPerson[ok].status, byPerson[ok].reason], ['SENT', null]);
    assert.deepEqual([byPerson[suppressed].status, byPerson[suppressed].reason], ['BLOCKED', 'SUPPRESSED']);
    assert.deepEqual([byPerson[noConsent].status, byPerson[noConsent].reason], ['BLOCKED', 'NO_CONSENT']);
    assert.deepEqual([byPerson[failing].status, byPerson[failing].reason], ['FAILED', 'PROVIDER_REJECTED']);
    assert.deepEqual(sentTo.sort(), [ok, failing].sort(), 'o adapter só é chamado depois de canSend permitir');
    for (const d of Object.values(byPerson)) assert.match(d.action_key, /^[0-9a-f]{64}$/, 'action_key sha256');
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT');
  });
});

test('step_de_campanha_avalia_cansend_na_hora_do_envio_e_finalidade_desconhecida_nunca_envia', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    let calls = 0;
    registerCampaignSendPort(buildCampaignSendPort({ send: async () => { calls += 1; return { ok: true }; } }));
    // a pessoa pede para sair DEPOIS de agendada e ANTES do envio: o canSend da hora do envio bloqueia
    const campaign = await scheduleFor(t, [p]);
    await suppress({ personId: p, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal(calls, 0);
    assert.deepEqual((await deliveries(t, campaign.id)).map((d) => `${d.status}:${d.reason}`), ['BLOCKED:SUPPRESSED']);

    // finalidade do público fora das listas: erro de configuração, nada é enviado
    const q2 = await readyPerson(t, A);
    const unknown = await scheduleFor(t, [q2], 'LANCAMENTO');
    await lifecycle.runLifecycleTick(A, t, new Date(TICK.getTime() + 60000));
    assert.equal(calls, 0);
    assert.deepEqual((await deliveries(t, unknown.id)).map((d) => `${d.status}:${d.reason}`), ['BLOCKED:PURPOSE_UNKNOWN']);
  });
});
