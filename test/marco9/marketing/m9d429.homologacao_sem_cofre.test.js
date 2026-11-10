'use strict';

// M9-D429 + M9-D202 (homologação de 10/11/2026) — a homologação subiu SEM cofre de segredos (SECRET_STORE_DRIVER vazio, ambiente HOMOLOG):
// o boot só exigia cofre em PRODUÇÃO. Cada e-mail de campanha precisa do link de descadastro assinado com a chave do cofre; sem cofre, o
// destinatário COM consentimento virou FAILED MKT_UNSUBSCRIBE_KEY_UNAVAILABLE e não recebeu nada. Este arquivo reproduz o defeito (sem cofre
// o e-mail não sai), mostra que com o cofre de arquivo (o recomendado para a homologação) o mesmo cenário entrega, e trava o boot de
// homologação sem cofre ou com o cofre em memória. Banco descartável, transação com rollback, sandbox determinístico.

const { allowTestUrls } = require('../_helpers/mktUrlPolicy');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const secrets = require('../../../src/features/integrations/secrets');
const { clearUnsubscribeKeyCache } = require('../../../src/features/marketing/publications/messaging/unsubscribe/unsubscribe.token');
const env = require('../_helpers/mktMsgEnv');

const { readyPerson, completeBody, loadSteps, q, adapters, messaging } = env;
const START = '2031-12-01T09:00:00';
const TICK = new Date('2031-12-01T12:00:10Z'); // 09:00:10 em São Paulo, fora do horário de silêncio
let A;
let driverAntes;
let dir;

before(async () => { ({ a: A } = await env.tenants()); driverAntes = process.env.SECRET_STORE_DRIVER; });
beforeEach(() => { adapters.resetSandbox(); clearUnsubscribeKeyCache(); registerCampaignSendPort(messaging.buildMessagingCampaignPort()); });
afterEach(() => {
  clearCampaignSendPort();
  secrets.setSecretStoreForTests(null);
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = null; }
  if (driverAntes === undefined) delete process.env.SECRET_STORE_DRIVER; else process.env.SECRET_STORE_DRIVER = driverAntes;
});
after(async () => { await sequelize.close(); });

/** Igual à homologação de 10/11: nenhuma variável de cofre no processo (getSecretStore recusa com INTEGRATION_SECRET_STORE_NOT_CONFIGURED). */
function semCofre() {
  delete process.env.SECRET_STORE_DRIVER;
  secrets.setSecretStoreForTests(null);
  assert.throws(() => secrets.getSecretStore(), (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED');
}

/** O que a homologação passa a ter: cofre de arquivo, chave mestra de 32 bytes, diretório fora do repositório. */
function cofreDeArquivo() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-cofre-homolog-'));
  secrets.setSecretStoreForTests(secrets.createFileMountedStore({ dir, masterKey: crypto.randomBytes(32).toString('hex') }));
}

/** O cenário (a) do aceite: um contato com consentimento e outro com opt-out, link de descadastro e domínio configurados. */
async function cenarioOptOut(t) {
  await allowTestUrls(t, A);
  await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
  const ok = await readyPerson(t, A);
  const optOut = await readyPerson(t, A);
  await suppress({ personId: optOut, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
  const templateId = await env.makeTemplate(t, A, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
  const body = completeBody({ templateId, personIds: [ok, optOut], startsAt: START, endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds: [ok, optOut] } }] });
  const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  await lifecycle.runLifecycleTick(A, t, TICK);
  const linhas = await q(t, 'SELECT person_id, status, reason FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaign.id });
  const porPessoa = Object.fromEntries(linhas.map((d) => [d.person_id, [d.status, d.reason]]));
  const mensagens = async (p) => q(t, "SELECT status, purpose FROM crm.messages WHERE company_id = :c AND person_id = :p AND direction = 'OUTBOUND'", { c: A.companyId, p });
  return { campaign, ok, optOut, porPessoa, mensagens };
}

test('homologacao_sem_cofre_o_email_de_campanha_falha_com_MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', async () => {
  semCofre();
  await withRollbackTenantTransaction(A, async (t) => {
    const r = await cenarioOptOut(t);
    // exatamente as duas linhas lidas do banco da homologação (campanha cfc5c8e1, 10/11/2026 19:07:20)
    assert.deepEqual(r.porPessoa[r.ok], ['FAILED', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE']);
    assert.deepEqual(r.porPessoa[r.optOut], ['BLOCKED', 'SUPPRESSED']);
    assert.equal((await r.mensagens(r.ok)).length, 0, 'sem cofre, o contato com consentimento fica sem mensagem');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0, 'o provedor de testes não recebe nada');
    assert.equal((await loadSteps(t, r.campaign.id))[0].status, 'SENT', 'o step fecha como SENT (houve um FAILED processado)');
  });
});

test('com_cofre_de_arquivo_o_mesmo_cenario_entrega_ao_contato_com_consentimento', async () => {
  cofreDeArquivo();
  await withRollbackTenantTransaction(A, async (t) => {
    const r = await cenarioOptOut(t);
    assert.deepEqual(r.porPessoa[r.ok], ['SENT', null]);
    assert.deepEqual(r.porPessoa[r.optOut], ['BLOCKED', 'SUPPRESSED']);
    assert.deepEqual((await r.mensagens(r.ok)).map((m) => [m.status, m.purpose]), [['SENT', 'MARKETING']]);
    assert.equal((await r.mensagens(r.optOut)).length, 0, 'o opt-out continua sem receber');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 1);
  });
});

test('boot_de_homologacao_sem_cofre_ou_com_cofre_em_memoria_e_recusado', () => {
  const arquivo = { SECRET_STORE_DRIVER: 'file-mounted', SECRET_STORE_DIR: path.join(os.tmpdir(), 'qa-m9-cofre-boot'), SECRET_STORE_MASTER_KEY: crypto.randomBytes(32).toString('hex') };
  const naoConfigurado = (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED' && e.statusCode === 500 && /homologação/.test(e.message) && /SECRET_STORE_DRIVER/.test(e.message);
  // a homologação real: imagem com NODE_ENV=production e ambiente de integração HOMOLOG (pelas duas variáveis que o definem)
  assert.throws(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production', INTEGRATION_ENVIRONMENT: 'HOMOLOG' }), naoConfigurado);
  assert.throws(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'staging' }), naoConfigurado);
  // cofre em memória: as chaves somem a cada reinício (link de descadastro de e-mail antigo deixaria de valer)
  assert.throws(() => secrets.assertSecretStoreAtBoot({ INTEGRATION_ENVIRONMENT: 'HOMOLOG', SECRET_STORE_DRIVER: 'http-vault', SECRET_STORE_VAULT_MODE: 'sandbox' }),
    (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG' && /homologação/.test(e.message));
  // configurações aceitas: cofre de arquivo na homologação; SANDBOX (máquina do desenvolvedor e CI) segue sem exigir cofre
  assert.doesNotThrow(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production', INTEGRATION_ENVIRONMENT: 'HOMOLOG', ...arquivo }));
  assert.doesNotThrow(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'development', SECRET_STORE_DRIVER: 'http-vault', SECRET_STORE_VAULT_MODE: 'sandbox' }));
  // produção continua como era
  assert.throws(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production' }), (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED' && /produção/.test(e.message));
});
