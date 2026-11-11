'use strict';

// Apoio dos testes da verificação K=7 do e-mail de campanha (falha transitória, UNKNOWN, cofre fora, reprocessamento). Não é teste.
// O cenário do sandbox entra no caminho REAL da campanha (lifecycle -> disparo -> porta -> sendMarketingMessage -> sendToChannel): a fachada dos adapters
// é envolvida ANTES de a mensagem carregar (message.send lê sendToChannel na carga). Cada arquivo de teste roda em processo próprio (node --test).
const adaptersFacade = require('../../../src/features/marketing/publications/adapters');

const realSend = adaptersFacade.sendToChannel;
const scenarioState = { current: null };
adaptersFacade.sendToChannel = (ch, msg, opts) => realSend(ch, msg, { ...opts, ...(scenarioState.current ? { scenario: scenarioState.current } : {}) });

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allowTestUrls } = require('./mktUrlPolicy');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const secrets = require('../../../src/features/integrations/secrets');
const { clearUnsubscribeKeyCache } = require('../../../src/features/marketing/publications/messaging/unsubscribe/unsubscribe.token');
const env = require('./mktMsgEnv');

const { q, adapters, messaging } = env;
const START = '2031-12-01T09:00:00'; // São Paulo
const END = '2031-12-10T18:00:00';
const T0 = new Date('2031-12-01T12:00:10Z'); // 09:00:10 em São Paulo, fora do horário de silêncio
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

const state = { dir: null, store: null };

/** Cofre de arquivo temporário (fora do repositório), porta da campanha registrada e sandbox limpo. */
function setUp() {
  adapters.resetSandbox(); clearUnsubscribeKeyCache(); scenarioState.current = null;
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9e-cofre-'));
  state.store = secrets.createFileMountedStore({ dir: state.dir, masterKey: crypto.randomBytes(32).toString('hex') });
  secrets.setSecretStoreForTests(state.store);
  registerCampaignSendPort(messaging.buildMessagingCampaignPort());
}
function tearDown() {
  clearCampaignSendPort(); secrets.setSecretStoreForTests(null); scenarioState.current = null;
  if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
  state.dir = null;
}

/** Cofre que responde "indisponível" a tudo (o cofre fora por um instante). */
const vaultDown = () => {
  const fail = async () => { const e = new Error('cofre fora'); e.code = 'INTEGRATION_SECRET_STORE_UNAVAILABLE'; throw e; };
  secrets.setSecretStoreForTests({ ...state.store, driver: state.store.driver, get: fail, put: fail, getAcceptedVersions: fail });
  clearUnsubscribeKeyCache();
};
const vaultBack = () => secrets.setSecretStoreForTests(state.store);

/** Campanha de e-mail agendada (finalidade MARKETING, descadastro configurado) para as pessoas; devolve a campanha. */
async function campaignFor(t, tenant, personIds, { startsAt = START, endsAt = END } = {}) {
  await allowTestUrls(t, tenant);
  await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', tenant, tenant.userId, t);
  const templateId = await env.makeTemplate(t, tenant, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
  const body = env.completeBody({ templateId, personIds, startsAt, endsAt, audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds } }] });
  const { campaign } = await campaigns.saveCampaign(tenant, tenant.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  return campaign;
}

const tick = (t, tenant, when) => lifecycle.runLifecycleTick(tenant, t, when);
const deliveries = (t, campaignId) => q(t, `SELECT id, person_id, status, reason, attempts, rate_deferrals, reconcile_attempts, next_attempt_at, external_ref
  FROM marketing.campaign_step_deliveries WHERE campaign_id = :c ORDER BY person_id`, { c: campaignId });
const one = async (t, campaignId) => (await deliveries(t, campaignId))[0];
const messagesOf = (t, tenant, personId) => q(t, `SELECT status, delivery_status, action_key, failure_reason FROM crm.messages
  WHERE company_id = :c AND person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at`, { c: tenant.companyId, p: personId });
const sent = (tenant) => adapters.sandboxRecordCount(tenant.companyId, 'EMAIL');
const setParam = (t, tenant, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);
const audits = (t, tenant, action, entityId) => q(t, `SELECT action, user_id, before_json, after_json, reason FROM audit.audit_log
  WHERE company_id = :c AND action = :a AND (CAST(:e AS uuid) IS NULL OR entity_id = CAST(:e AS uuid)) ORDER BY occurred_at`, { c: tenant.companyId, a: action, e: entityId || null });
const stepOf = async (t, campaignId) => (await env.loadSteps(t, campaignId))[0];

module.exports = {
  ...env, scenario: scenarioState, setUp, tearDown, vaultDown, vaultBack, campaignFor, tick, deliveries, one, messagesOf, sent, setParam, audits, stepOf, T0, at, START, END,
};
