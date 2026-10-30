'use strict';

// M9-D429 (transferido da M9-D412, M9-D416 e M9-D418) — o step de campanha é enviado pelo adapter real do canal (ChannelAdapter da M9-D430) depois do canSend,
// com a action_key sha256 como chave de idempotência, gravando SENT, BLOCKED ou FAILED; a mensagem do CRM leva a finalidade e o status do canal; o horário de
// silêncio adia o destinatário sem perdê-lo. Banco descartável, transação com rollback, sandbox determinístico.

const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const env = require('../_helpers/mktMsgEnv');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, completeBody, loadSteps, q, adapters, messaging } = env;
let A;
let offVault;
before(async () => { ({ a: A } = await env.tenants()); offVault = useTempSecretStore(); });
beforeEach(() => { adapters.resetSandbox(); registerCampaignSendPort(messaging.buildMessagingCampaignPort()); });
afterEach(() => clearCampaignSendPort());
after(async () => { offVault(); await sequelize.close(); });
const START = '2031-12-01T09:00:00';
const TICK = new Date('2031-12-01T12:00:10Z'); // 09:00:10 em São Paulo, fora do silêncio
const NIGHT = new Date('2031-12-02T01:30:00Z'); // 22:30 em São Paulo
const NEXT_MORNING = new Date('2031-12-02T11:00:10Z'); // 08:00:10 em São Paulo

async function scheduleFor(t, personIds, { body = 'Conheça o Aurora, um lançamento novo.' } = {}) {
  const templateId = await env.makeTemplate(t, A, { channel: 'EMAIL', official: null, body, variables: [] });
  const base = completeBody({ templateId, personIds, startsAt: START, endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds } }] });
  const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...base, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  return campaign;
}
const deliveries = (t, campaignId) => q(t, 'SELECT person_id, status, reason, action_key, external_ref FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaignId });
const messageOf = (t, personId) => q(t, "SELECT status, purpose, action_key, external_message_id, channel FROM crm.messages WHERE company_id = :c AND person_id = :p AND direction = 'OUTBOUND'", { c: A.companyId, p: personId });

test('step_de_campanha_enviado_pelo_adapter_real_grava_sent_blocked_ou_failed', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const ok = await readyPerson(t, A);
    const suppressed = await readyPerson(t, A);
    await suppress({ personId: suppressed, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    const campaign = await scheduleFor(t, [ok, suppressed]);
    await lifecycle.runLifecycleTick(A, t, TICK);
    const byPerson = Object.fromEntries((await deliveries(t, campaign.id)).map((d) => [d.person_id, d]));
    // SENT: pelo ChannelAdapter, com a action_key sha256 como chave de idempotência
    assert.deepEqual([byPerson[ok].status, byPerson[ok].reason], ['SENT', null]);
    assert.match(byPerson[ok].action_key, /^[0-9a-f]{64}$/);
    assert.match(byPerson[ok].external_ref, /^sbx-email-[0-9a-f]{16}$/);
    const sandboxed = await (await adapters.resolveChannelAdapter('EMAIL', { tenant: A, transaction: t, mode: 'SANDBOX' })).findByIdempotencyKey(byPerson[ok].action_key);
    assert.equal(sandboxed.found, true, 'a chave de idempotência do canal é a action_key do step');
    // a mensagem do CRM leva a finalidade e o status do canal (SENT)
    const [msg] = await messageOf(t, ok);
    assert.deepEqual([msg.status, msg.purpose, msg.action_key, msg.channel], ['SENT', 'MARKETING', byPerson[ok].action_key, 'EMAIL']);
    // BLOCKED: motivo do canSend e o canal nem é chamado
    assert.deepEqual([byPerson[suppressed].status, byPerson[suppressed].reason], ['BLOCKED', 'SUPPRESSED']);
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 1);
    assert.equal((await messageOf(t, suppressed)).length, 0);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT');
  });
});

test('step_de_campanha_falha_com_o_codigo_da_regra_e_o_corpo_do_email_nao_e_preview', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    // sem endereço de descadastro configurado, o e-mail de marketing é recusado (MKT_UNSUBSCRIBE_REQUIRED): FAILED, nunca exceção anônima
    const p1 = await readyPerson(t, A);
    const c1 = await scheduleFor(t, [p1]);
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.deepEqual((await deliveries(t, c1.id)).map((d) => [d.status, d.reason]), [['FAILED', 'MKT_UNSUBSCRIBE_REQUIRED']]);
    assert.equal((await messageOf(t, p1)).length, 0, 'recusado: nenhuma mensagem aceita');
    // o preview do e-mail é o assunto (o nome da campanha) e o pré-cabeçalho: dado sensível só no corpo não impede o envio
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const p2 = await readyPerson(t, A);
    const c2 = await scheduleFor(t, [p2], { body: 'Sua parcela de R$ 1.250,00 vence amanhã.' });
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await deliveries(t, c2.id)).length, 1);
    assert.equal((await messageOf(t, p2)).length, 1, 'o corpo do e-mail não é preview: o assunto é o nome da campanha');
  });
});

test('quiet_hours_reagenda_sem_perder', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const p = await readyPerson(t, A);
    const campaign = await scheduleFor(t, [p]);
    await lifecycle.runLifecycleTick(A, t, NIGHT);
    assert.equal((await deliveries(t, campaign.id)).length, 0, 'às 22:30 nada é gravado como perdido');
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SCHEDULED', 'o step segue agendado');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0);
    await lifecycle.runLifecycleTick(A, t, NEXT_MORNING);
    assert.deepEqual((await deliveries(t, campaign.id)).map((d) => d.status), ['SENT'], 'às 08:00 sai');
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT');
  });
});

test('porta_da_campanha_so_e_registrada_na_subida_do_job_e_respeita_porta_de_outro_dono', async () => {
  clearCampaignSendPort();
  const { getCampaignSendPort } = require('../../../src/features/marketing/campaigns');
  assert.equal(getCampaignSendPort(), null, 'carregar o módulo de mensagens não registra a porta sozinho');
  messaging.installCampaignSendPort();
  const mine = getCampaignSendPort();
  assert.ok(mine && typeof mine.canSend === 'function' && typeof mine.send === 'function');
  messaging.installCampaignSendPort();
  assert.equal(getCampaignSendPort(), mine, 'instalar de novo não troca a porta');
  clearCampaignSendPort();
  const other = { canSend: async () => ({ allowed: true }), send: async () => ({ ok: true }) };
  registerCampaignSendPort(other);
  messaging.installCampaignSendPort();
  assert.equal(getCampaignSendPort(), other, 'porta de outro dono não é trocada');
});
