'use strict';

// M9-D425 (teste 8) — FALHA FECHADA: se o estado do kill switch não puder ser lido (banco indisponível, erro de consulta, sem transação), toda ação de saída é bloqueada e a
// transação do chamador continua utilizável. Postgres real (RLS FORCE), transação com rollback, sandbox determinístico. Só em banco descartável.

const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { allowTestUrls } = require('../_helpers/mktUrlPolicy');
const env = require('../_helpers/m9d425Env');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, completeBody, loadSteps, q, adapters, messaging, ks, withBrokenState, mkCampaign } = env;
let A;
let offVault;
before(async () => { ({ a: A } = await env.tenants()); offVault = useTempSecretStore(); });
beforeEach(() => { adapters.resetSandbox(); registerCampaignSendPort(messaging.buildMessagingCampaignPort()); });
afterEach(() => clearCampaignSendPort());
after(async () => { offVault(); await sequelize.close(); });

const mail = (personId) => ({ channel: 'EMAIL', personId, purpose: 'MARKETING', actionKey: env.key(), subject: 'Novidades', text: 'Veja os imóveis.', unsubscribeUrl: 'https://www.exemplo.test/d?t=1' });
const code = (promise) => Promise.resolve(promise).then(() => null, (e) => [e.statusCode, e.code, e.details && e.details.unreadable]);

/** Executa fn com a leitura da coluna da campanha quebrada no SQL (o banco "falha" só nessa consulta). */
async function withBrokenSql(fn) {
  const original = sequelize.query.bind(sequelize);
  sequelize.query = (sql, ...rest) => (typeof sql === 'string' && sql.includes('SELECT kill_switch_active FROM') ? Promise.reject(new Error('conexão perdida (teste)')) : original(sql, ...rest));
  try { return await fn(); } finally { sequelize.query = original; }
}

test('falha_ao_ler_estado_bloqueia', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const person = await readyPerson(t, A);
    assert.equal((await env.send(t, A, mail(person))).status, 'SENT', 'com o estado legível a mensagem sai');
    const baseline = adapters.sandboxRecordCount(A.companyId, 'EMAIL');
    await withBrokenState(async () => {
      const state = await ks.readKillState(A, { channel: 'EMAIL' }, t);
      assert.deepEqual([state.blocked, state.unreadable], [true, true]);
      assert.deepEqual(await code(ks.assertOutboundAllowed(A, { channel: 'EMAIL' }, t)), [423, 'MKT_KILL_SWITCH_ACTIVE', true]);
      const decision = await ks.isOutboundBlocked(A, { channel: 'EMAIL' }, t);
      assert.deepEqual([decision.blocked, decision.blockReason], [true, 'KILL_SWITCH']);
      const out = await env.send(t, A, mail(person));
      assert.deepEqual([out.status, out.reason, out.sent], ['BLOCKED', 'KILL_SWITCH', false]);
      assert.deepEqual((await code(adapters.sendToChannel('EMAIL', { to: 'x@exemplo.test', text: 'y', subject: 's' }, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: env.key() })))?.slice(0, 2), [423, 'MKT_KILL_SWITCH_ACTIVE']);
    });
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), baseline, 'nada saiu enquanto o estado estava ilegível');
    // a transação do chamador continua utilizável (o erro foi contido num savepoint) e, lido de novo, o envio volta
    assert.equal((await q(t, 'SELECT 1 AS ok', {}))[0].ok, 1);
    assert.equal((await env.send(t, A, mail(person))).status, 'SENT');
  });
});

test('erro_de_consulta_da_campanha_bloqueia_e_nao_derruba_a_transacao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const campaign = await mkCampaign(t, A);
    await withBrokenSql(async () => {
      const state = await ks.readKillState(A, { campaignId: campaign.id }, t);
      assert.deepEqual([state.blocked, state.unreadable], [true, true]);
    });
    assert.equal((await ks.readKillState(A, { campaignId: campaign.id }, t)).blocked, false, 'consulta restabelecida: libera');
    assert.equal((await q(t, 'SELECT count(*)::int AS n FROM marketing.campaigns WHERE id = :id', { id: campaign.id }))[0].n, 1, 'o que a transação já tinha feito permanece');
  });
});

test('sem_transacao_nao_ha_como_ler_e_bloqueia', async () => {
  const state = await ks.readKillState(A, { channel: 'EMAIL' }, undefined);
  assert.deepEqual([state.blocked, state.unreadable], [true, true]);
  assert.deepEqual(await code(ks.assertOutboundAllowed(A, {}, null)), [423, 'MKT_KILL_SWITCH_ACTIVE', true]);
});

test('disparo_de_campanha_com_estado_ilegivel_nao_envia_e_o_passo_continua_agendado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await allowTestUrls(t, A); // M9-D433: o link de descadastro passa pela regra de URL externa
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const person = await readyPerson(t, A);
    const templateId = await env.makeTemplate(t, A, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
    const base = completeBody({ templateId, personIds: [person], startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds: [person] } }] });
    const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...base, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
    const tick = new Date('2031-12-01T12:00:10Z');
    await withBrokenState(() => lifecycle.runLifecycleTick(A, t, tick));
    assert.equal((await q(t, 'SELECT count(*)::int AS n FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaign.id }))[0].n, 0);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SCHEDULED');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0);
    await lifecycle.runLifecycleTick(A, t, tick);
    assert.equal((await loadSteps(t, campaign.id))[0].status, 'SENT', 'estado legível de novo: o mesmo passo sai');
  });
});
