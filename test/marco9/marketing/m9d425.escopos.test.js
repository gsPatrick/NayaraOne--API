'use strict';

// M9-D425 — kill switch do Marketing: os quatro escopos (global, canal, campanha, automação) funcionam isolados e combinados; com qualquer um ligado nenhuma ação de saída
// sai; desligar não apaga nada; ao reativar, o que ficou pendente é processado. Postgres real (RLS FORCE), transação com rollback, sandbox determinístico. Só em banco descartável.

const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const env = require('../_helpers/m9d425Env');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, completeBody, loadSteps, q, adapters, messaging, ks, on, off, mkCampaign, mkFlow } = env;
let A;
let offVault;
before(async () => { ({ a: A } = await env.tenants()); offVault = useTempSecretStore(); });
beforeEach(() => { adapters.resetSandbox(); registerCampaignSendPort(messaging.buildMessagingCampaignPort()); });
afterEach(() => clearCampaignSendPort());
after(async () => { offVault(); await sequelize.close(); });

const mail = (personId, over = {}) => ({ channel: 'EMAIL', personId, purpose: 'MARKETING', actionKey: env.key(), subject: 'Novidades do mês', text: 'Veja os imóveis novos.', unsubscribeUrl: 'https://www.exemplo.test/descadastro?t=abc', ...over });
const wa = (personId, over = {}) => ({ channel: 'WHATSAPP', personId, purpose: 'MARKETING', actionKey: env.key(), text: 'Olá! Temos novidades no seu Radar.', ...over });
const crmCount = async (t, personId) => (await q(t, "SELECT count(*)::int AS n FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND'", { p: personId }))[0].n;
const START = '2031-12-01T09:00:00';
const TICK = new Date('2031-12-01T12:00:10Z');

async function schedule(t, personIds) {
  const templateId = await env.makeTemplate(t, A, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
  const base = completeBody({ templateId, personIds, startsAt: START, endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds } }] });
  const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...base, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  return campaign;
}
const deliveries = (t, campaignId) => q(t, 'SELECT person_id, status, reason FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaignId });

test('kill_switch_ativo_nenhuma_acao_outbound', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const person = await readyPerson(t, A);
    assert.equal((await env.send(t, A, mail(person))).status, 'SENT', 'sem kill switch a mensagem sai');
    const baseline = adapters.sandboxRecordCount(A.companyId, 'EMAIL');

    const r = await on(t, A, 'GLOBAL');
    assert.deepEqual([r.active, r.changed, r.scope], [true, true, 'GLOBAL']);
    // mensagem direta: BLOCKED com o motivo KILL_SWITCH, nada grava no CRM e o canal nem é chamado
    for (const input of [mail(person), wa(person)]) {
      const out = await env.send(t, A, input);
      assert.deepEqual([out.status, out.reason, out.code, out.sent], ['BLOCKED', 'KILL_SWITCH', 'MKT_KILL_SWITCH_ACTIVE', false]);
    }
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), baseline);
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'WHATSAPP'), 0);
    assert.equal(await crmCount(t, person), 1, 'só a mensagem de antes do kill switch');
    // o ponto único de saída recusa com 423, para todos os canais, sem resolver adapter
    for (const channel of ['EMAIL', 'WHATSAPP', 'INSTAGRAM', 'SITE', 'PORTAL']) {
      await assert.rejects(() => adapters.sendToChannel(channel, { to: 'x', text: 'y' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key() }),
        (e) => e.statusCode === 423 && e.code === 'MKT_KILL_SWITCH_ACTIVE', channel);
    }
    const decision = await ks.isOutboundBlocked(A, { channel: 'EMAIL' }, t);
    assert.deepEqual([decision.blocked, decision.blockReason, decision.blockedBy[0].scope], [true, 'KILL_SWITCH', 'GLOBAL']);
    // ao reativar, volta a sair
    await off(t, A, 'GLOBAL');
    assert.equal((await env.send(t, A, mail(person))).status, 'SENT');
  });
});

test('kill_switch_por_canal_nao_afeta_outros', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const person = await readyPerson(t, A);
    await on(t, A, 'CHANNEL', 'instagram'); // o canal vem normalizado (maiúsculas)
    await assert.rejects(() => adapters.sendToChannel('INSTAGRAM', { text: 'post' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key() }), (e) => e.code === 'MKT_KILL_SWITCH_ACTIVE');
    // e-mail e WhatsApp continuam normais
    assert.equal((await env.send(t, A, mail(person))).status, 'SENT');
    await env.openWindow(t, A, person, 1);
    assert.equal((await env.send(t, A, wa(person))).status, 'SENT');
    assert.deepEqual((await ks.readKillState(A, { channel: 'EMAIL' }, t)).active, []);
    assert.deepEqual((await ks.readKillState(A, { channel: 'INSTAGRAM' }, t)).active, [{ scope: 'CHANNEL', target: 'INSTAGRAM' }]);
    // vários canais podem estar ligados ao mesmo tempo; basta um para bloquear uma lista de canais
    await on(t, A, 'CHANNEL', 'EMAIL');
    assert.equal((await env.send(t, A, mail(person))).status, 'BLOCKED');
    assert.equal((await ks.readKillState(A, { channel: ['WHATSAPP', 'EMAIL'] }, t)).blocked, true);
    await off(t, A, 'CHANNEL', 'EMAIL');
    assert.equal((await ks.readKillState(A, { channel: 'EMAIL' }, t)).blocked, false);
  });
});

test('kill_switch_por_campanha_e_automacao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const c1 = await mkCampaign(t, A);
    const c2 = await mkCampaign(t, A);
    const f1 = await mkFlow(t, A);
    const f2 = await mkFlow(t, A);
    const r = await on(t, A, 'CAMPAIGN', c1.id.toUpperCase());
    assert.deepEqual([r.active, r.targetCode], [true, c1.code]);
    await on(t, A, 'AUTOMATION', f1.id);
    // isolados: só o alvo ligado bloqueia; o global e os outros alvos seguem livres
    assert.deepEqual((await ks.readKillState(A, { campaignId: c1.id }, t)).active, [{ scope: 'CAMPAIGN', target: c1.id }]);
    assert.equal((await ks.readKillState(A, { campaignId: c2.id }, t)).blocked, false);
    assert.deepEqual((await ks.readKillState(A, { automationId: f1.id }, t)).active, [{ scope: 'AUTOMATION', target: f1.id }]);
    assert.equal((await ks.readKillState(A, { automationId: f2.id }, t)).blocked, false);
    assert.equal((await ks.readKillState(A, { channel: 'EMAIL' }, t)).blocked, false);
    // a coluna da campanha e do fluxo guarda quando, quem e por quê
    const [row] = await q(t, 'SELECT kill_switch_active, kill_switch_at, kill_switch_by, kill_switch_reason FROM marketing.campaigns WHERE id = :id', { id: c1.id });
    assert.deepEqual([row.kill_switch_active, row.kill_switch_by, row.kill_switch_reason], [true, A.userId, 'QA-M9 teste do kill switch']);
    assert.ok(row.kill_switch_at);
    // combinados: a ação de uma campanha E de uma automação com os dois ligados lista os dois; o envio fica recusado por qualquer um
    assert.equal((await ks.readKillState(A, { campaignId: c1.id, automationId: f1.id }, t)).active.length, 2);
    await assert.rejects(() => adapters.sendToChannel('EMAIL', { to: 'x', text: 'y' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key(), campaignId: c1.id }), (e) => e.code === 'MKT_KILL_SWITCH_ACTIVE');
    await assert.rejects(() => adapters.sendToChannel('EMAIL', { to: 'x', text: 'y' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key(), automationId: f1.id }), (e) => e.code === 'MKT_KILL_SWITCH_ACTIVE');
    await adapters.sendToChannel('EMAIL', { to: 'x@exemplo.test', text: 'y', subject: 's' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key(), campaignId: c2.id, automationId: f2.id });
    // campanha de outra empresa não existe para esta
    const other = await mkCampaign(t, A);
    await off(t, A, 'CAMPAIGN', c1.id);
    const [cleared] = await q(t, 'SELECT kill_switch_active, kill_switch_at, kill_switch_by, kill_switch_reason FROM marketing.campaigns WHERE id = :id', { id: c1.id });
    assert.deepEqual([cleared.kill_switch_active, cleared.kill_switch_at, cleared.kill_switch_by, cleared.kill_switch_reason], [false, null, null, null]);
    assert.equal((await ks.readKillState(A, { campaignId: other.id }, t)).blocked, false);
  });
});

test('desativacao_nao_apaga_configuracao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const person = await readyPerson(t, A);
    const campaign = await schedule(t, [person]);
    const flow = await mkFlow(t, A);
    const count = async () => ({
      steps: (await q(t, 'SELECT count(*)::int AS n FROM marketing.campaign_steps WHERE campaign_id = :c', { c: campaign.id }))[0].n,
      audiences: (await q(t, 'SELECT count(*)::int AS n FROM marketing.campaign_audiences WHERE campaign_id = :c', { c: campaign.id }))[0].n,
      templates: (await q(t, 'SELECT count(*)::int AS n FROM marketing.templates WHERE company_id = :c AND deleted_at IS NULL', { c: A.companyId }))[0].n,
      campaignRow: (await q(t, 'SELECT code, name, objective, status, channels FROM marketing.campaigns WHERE id = :c', { c: campaign.id }))[0],
      flowRow: (await q(t, 'SELECT code, name, status, risk_level FROM marketing.automation_flows WHERE id = :f', { f: flow.id }))[0],
    });
    const before = await count();
    await on(t, A, 'GLOBAL');
    await on(t, A, 'CHANNEL', 'EMAIL');
    await on(t, A, 'CAMPAIGN', campaign.id);
    await on(t, A, 'AUTOMATION', flow.id);
    assert.deepEqual(await count(), before, 'ligar não apaga versões, templates, passos, públicos nem fluxos');
    await off(t, A, 'GLOBAL');
    await off(t, A, 'CHANNEL', 'EMAIL');
    await off(t, A, 'CAMPAIGN', campaign.id);
    await off(t, A, 'AUTOMATION', flow.id);
    assert.deepEqual(await count(), before, 'reativar também não muda a configuração');
    // a chave do registro continua existindo (desligada), com histórico de versões
    const flag = await env.flagRow(t, A, 'marketing.sending.kill');
    assert.deepEqual([flag.value, flag.is_kill_switch, flag.risk], [false, true, 'CRITICAL']);
    assert.ok(flag.version >= 3, 'ligou e desligou: duas versões novas');
    const versions = await q(t, 'SELECT count(*)::int AS n FROM governance.flag_versions WHERE entry_id = :id', { id: flag.id });
    assert.equal(versions[0].n, 2);
  });
});

test('jobs_pendentes_sao_processados_apos_reativar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const person = await readyPerson(t, A);
    const campaign = await schedule(t, [person]);
    await on(t, A, 'GLOBAL');
    // o passo venceu (09:00:10 de 01/12), mas com o kill switch ligado nada é enviado nem descartado
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await deliveries(t, campaign.id)).length, 0);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SCHEDULED', 'o passo continua agendado, não é cancelado');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0);
    // reativa: no próximo ciclo o mesmo passo é processado, com as mesmas pré-condições
    await off(t, A, 'GLOBAL');
    await lifecycle.runLifecycleTick(A, t, new Date(TICK.getTime() + 60000));
    assert.deepEqual((await deliveries(t, campaign.id)).map((d) => d.status), ['SENT']);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 1);
  });
});

test('kill_switch_de_canal_e_de_campanha_seguram_o_passo_e_o_ligado_no_meio_do_lote_nao_perde_destinatario', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const people = [await readyPerson(t, A), await readyPerson(t, A)];
    const byChannel = await schedule(t, people);
    await on(t, A, 'CHANNEL', 'EMAIL');
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await deliveries(t, byChannel.id)).length, 0, 'canal EMAIL ligado: o passo de e-mail espera');
    await off(t, A, 'CHANNEL', 'EMAIL');
    await on(t, A, 'CAMPAIGN', byChannel.id);
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await deliveries(t, byChannel.id)).length, 0, 'campanha ligada: o passo espera');
    await off(t, A, 'CAMPAIGN', byChannel.id);
    // se o kill switch liga entre o canSend da porta e o envio, o destinatário não vira FAILED: continua pendente
    registerCampaignSendPort({ canSend: async () => ({ allowed: true }), send: async () => ({ ok: false, errorCode: 'MKT_KILL_SWITCH_ACTIVE' }) });
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await deliveries(t, byChannel.id)).length, 0);
    assert.equal((await loadSteps(t, byChannel.id))[0].status, 'SCHEDULED');
  });
});
