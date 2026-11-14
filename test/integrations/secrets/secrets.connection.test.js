'use strict';

// Marco 9, M9-D202 — segredo ligado à connection: formato e isolamento da referência, leitura auditada,
// cache, regras do BANK (worker, driver, 90 dias, MFA), rotação, vencimento e parâmetros.
// Roda em banco descartável (withDisposableDb); cada prova é uma transação com rollback.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { IntegrationConnection, AuditLog } = require('../../../src/models');
const registry = require('../../../src/features/integrations/registry/registry.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { gravarParametro } = require('../../helpers/mfaRecente');
const secrets = require('../../../src/features/integrations/secrets');
const { semMfa } = require('../../marco9/_helpers/semMfa');

const DIA = 24 * 3600 * 1000;
const VALOR = 'valor-do-cofre-QA-M9-abcdef';
let tenant;
let ctx;
let agora;
const relogio = () => new Date(agora);

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
});
afterEach(() => { secrets.clearSecretIncidentReporters(); secrets.clearSecretCache(); });
after(() => sequelize.close());

const refDe = (suf = uniqueSuffix(), empresa = tenant.companyId) => `company/${empresa}/qa-m9-${suf}/api-key`;
const novaConexao = (over = {}) => ({ providerCode: 'bank-sandbox', environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, ...over });
const loja = () => secrets.createHttpVaultStore({ mode: 'sandbox', clock: relogio });
// Chave `platformOnly` só grava com a marca de plataforma (D870); as demais, como o ADMIN da empresa.
async function config(transaction, chave, valor) {
  const platform = settingsService.SETTINGS_SCHEMA[chave]?.platformOnly === true;
  await gravarParametro(chave, valor, tenant, transaction, { platform }); // sensível (requiresMfa): operador com MFA recente real
}
async function recusa(promessa, code, status) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode ?? err.status, status);
    return true;
  });
}
async function comAgora(fn) {
  agora = Date.now();
  return withRollbackTenantTransaction(tenant, fn);
}

test('connection_secret_ref_formato_invalido', async () => {
  await comAgora(async (transaction) => {
    for (const ruim of ['abc', 'Company/x/ABC/maiusculo', 'com espaco/aqui/ok', `company/${tenant.companyId}/${'a'.repeat(105)}`, '/comeca/com/barra']) {
      await recusa(registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: ruim }), ctx, transaction), 'INTEGRATION_SECRET_REF_INVALID', 422);
    }
    // Sem o prefixo company/<id>/ a referência é recusada (parâmetro ligado por padrão).
    await recusa(registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: 'nayara/prod/bank-sandbox/api-key' }), ctx, transaction), 'INTEGRATION_SECRET_REF_INVALID', 422);
    const ok = await registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: refDe() }), ctx, transaction);
    assert.ok(ok.secretRef.startsWith(`company/${tenant.companyId}/`));
    // Desligado pelo administrador, o apelido sem prefixo vale.
    await config(transaction, 'integration.secret.require_company_prefix', false);
    const livre = await registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: 'nayara/prod/bank-sandbox/api-key' }), ctx, transaction);
    assert.equal(livre.secretRef, 'nayara/prod/bank-sandbox/api-key');
    // Edição valida igual.
    await recusa(registry.updateConnection(ok.id, { secretRef: 'x' }, ctx, transaction), 'INTEGRATION_SECRET_REF_INVALID', 422);
    // Segredo em campo comum continua recusado (D200) e a referência não pode ser compartilhada.
    await recusa(registry.createConnection(novaConexao({ providerCode: 'email-sandbox', apiKey: 'abc123' }), ctx, transaction), 'INTEGRATION_SECRET_IN_CONFIG', 422);
    await recusa(registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: ok.secretRef }), ctx, transaction), 'INTEGRATION_SECRET_REF_SHARED', 409);
  });
});

test('connection_secret_ref_legado_vault_so_pelo_correspondente', async () => {
  await comAgora(async (transaction) => {
    await recusa(registry.createConnection(novaConexao({ providerCode: 'financing-manual', secretRef: 'vault:correspondent/x' }), ctx, transaction), 'INTEGRATION_SECRET_REF_INVALID', 422);
    const c = await registry.createConnection(novaConexao({ providerCode: 'financing-manual', secretRef: 'vault:correspondent/x' }), ctx, transaction, { legacySecretRef: true });
    assert.equal(c.secretRef, 'vault:correspondent/x');
    // O cofre não lê referência legada.
    await recusa(secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store: loja(), now: agora }), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  });
});

test('secret_isolamento_entre_empresas', async () => {
  await comAgora(async (transaction) => {
    const outra = '99999999-9999-4999-8999-999999999999';
    await recusa(registry.createConnection(novaConexao({ secretRef: refDe('x', outra) }), ctx, transaction), 'INTEGRATION_SECRET_REF_FOREIGN_COMPANY', 422);
    // Mesmo que a referência estranha chegue ao banco por outro caminho, a leitura recusa.
    const c = await registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: refDe() }), ctx, transaction);
    const store = loja();
    await store.put(refDe('y', outra), VALOR, {});
    await sequelize.query('UPDATE integration.connections SET secret_ref = :r WHERE id = :id', { transaction, replacements: { r: refDe('y', outra), id: c.id } });
    const recarregada = await registry.getConnection(c.id, ctx, transaction);
    await recusa(secrets.readConnectionSecret(recarregada, ctx, { purpose: 'dispatch', transaction, store, now: agora }), 'INTEGRATION_SECRET_REF_FOREIGN_COMPANY', 422);
    // Connection de outra empresa não é lida com o contexto desta.
    await recusa(secrets.readConnectionSecret(recarregada, { ...ctx, companyId: outra }, { purpose: 'dispatch', transaction, store, now: agora }), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
  });
});

async function criarComSegredo(transaction, over = {}, store = loja()) {
  await config(transaction, 'integration.secret.mfa_on_bank_secret_change', false);
  const ref = refDe();
  const c = await registry.createConnection(novaConexao({ secretRef: ref, ...over }), ctx, transaction);
  await store.put(ref, VALOR, {});
  return { c, ref, store };
}

test('secret_read_gera_auditoria_sem_valor', async () => {
  await comAgora(async (transaction) => {
    const { c, store } = await criarComSegredo(transaction, { providerCode: 'email-sandbox' });
    const lido = await secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store, now: agora });
    assert.equal(lido.value.reveal(), VALOR);
    assert.equal(lido.version, 1);
    assert.ok(!JSON.stringify(lido).includes(VALOR));
    const linhas = await AuditLog.findAll({ where: { action: 'integration.secret.read', entityId: c.id }, transaction });
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].afterJson.connectionId, c.id);
    assert.equal(linhas[0].afterJson.purpose, 'dispatch');
    assert.equal(linhas[0].userId, tenant.userId);
    assert.ok(!JSON.stringify(linhas[0].toJSON()).includes(VALOR));
    assert.ok(!JSON.stringify(linhas[0].toJSON()).includes('secretRef'), 'nem a referência vai para a trilha');
  });
});

test('secret_cache_respeita_ttl_configuravel', async () => {
  await comAgora(async (transaction) => {
    const { c, ref, store } = await criarComSegredo(transaction, { providerCode: 'email-sandbox' });
    const ler = () => secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store, now: agora });
    assert.equal((await ler()).value.reveal(), VALOR);
    await store.put(ref, 'nova-versao-sem-promover-1234', {});
    agora += 59 * 1000;
    assert.equal((await ler()).version, 1, 'dentro do TTL (padrão 60 s) vale a versão antiga');
    agora += 2 * 1000;
    const depois = await ler();
    assert.equal(depois.version, 2, 'passado o TTL lê de novo');
    // TTL zero desliga o cache.
    await config(transaction, 'integration.secret.cache_ttl_s', 0);
    secrets.clearSecretCache();
    await store.put(ref, 'outra-versao-sem-promover-5678', {});
    assert.equal((await ler()).version, 3);
  });
});

test('bank_leitura_so_pelo_worker_e_auditada_a_cada_leitura', async () => {
  await comAgora(async (transaction) => {
    const { c, store } = await criarComSegredo(transaction);
    await recusa(secrets.readConnectionSecret(c, ctx, { purpose: 'user-request', transaction, store, now: agora }), 'INTEGRATION_SECRET_BANK_WORKER_ONLY', 403);
    await recusa(secrets.readConnectionSecret(c, ctx, { purpose: 'qualquer-coisa', transaction, store, now: agora }), 'VALIDATION_ERROR', 400);
    await secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store, now: agora });
    await secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store, now: agora }); // cache: ainda audita
    const linhas = await AuditLog.findAll({ where: { action: 'integration.secret.read', entityId: c.id }, transaction });
    assert.equal(linhas.length, 2);
    // O webhook secret segue a mesma regra, com a referência irmã ".../webhook-secret".
    await store.put(`${c.secretRef}/webhook-secret`, 'segredo-do-webhook-1234', {});
    const wh = await secrets.readConnectionSecret(c, ctx, { purpose: 'webhook', kind: 'webhook', transaction, store, now: agora });
    assert.equal(wh.value.reveal(), 'segredo-do-webhook-1234');
  });
});

test('bank_secret_driver_file_proibido_em_producao_na_leitura', async () => {
  await comAgora(async (transaction) => {
    await config(transaction, 'integration.admin.mfa_on_prod_connection_change', false);
    await config(transaction, 'integration.secret.mfa_on_bank_secret_change', false);
    const c = await registry.createConnection(novaConexao({ environment: 'PRODUCTION', secretRef: refDe() }), ctx, transaction);
    const arquivo = { driver: 'file-mounted', get: async () => { throw new Error('não deveria chegar ao cofre'); } };
    await recusa(secrets.readConnectionSecret(c, ctx, { purpose: 'dispatch', transaction, store: arquivo, now: agora }), 'INTEGRATION_SECRET_DRIVER_FORBIDDEN', 500);
  });
});

test('secret_expirado_coloca_connection_auth_failed', async () => {
  await comAgora(async (transaction) => {
    const incidentes = [];
    secrets.registerSecretIncidentReporter(async (i) => incidentes.push(i));
    const { c, store } = await criarComSegredo(transaction, { providerCode: 'email-sandbox' });
    await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    await IntegrationConnection.update({ secretExpiresAt: new Date(agora - 1000) }, { where: { id: c.id }, transaction });
    const viva = await registry.getConnection(c.id, ctx, transaction);
    const r = await secrets.enforceSecretExpiry(viva, ctx, transaction, { store, now: agora });
    assert.equal(r.state, 'EXPIRED');
    assert.equal(r.transitioned, true);
    assert.equal((await registry.getConnection(c.id, ctx, transaction)).status, 'AUTH_FAILED');
    assert.equal(incidentes.length, 1);
    assert.equal(incidentes[0].code, 'INTEGRATION_SECRET_EXPIRED');
    assert.equal(incidentes[0].connectionId, c.id);
    assert.ok(!JSON.stringify(incidentes).includes(VALOR));
    const linhas = await AuditLog.findAll({ where: { action: 'integration.secret.expired', entityId: c.id }, transaction });
    assert.equal(linhas.length, 1);
    // Idempotente: já está AUTH_FAILED, não transita nem reporta de novo.
    const de_novo = await secrets.enforceSecretExpiry(await registry.getConnection(c.id, ctx, transaction), ctx, transaction, { store, now: agora });
    assert.equal(de_novo.transitioned, false);
    assert.equal(incidentes.length, 1);
    // Leitura de segredo vencido é recusada.
    await recusa(secrets.readConnectionSecret(await registry.getConnection(c.id, ctx, transaction), ctx, { purpose: 'dispatch', transaction, store, now: agora }), 'INTEGRATION_SECRET_EXPIRED', 409);
  });
});

async function bankComIdade(transaction, dias) {
  await sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE status = 'ACTIVE' AND provider_code = 'bank-sandbox' AND environment = 'SANDBOX'", { transaction });
  const { c, store } = await criarComSegredo(transaction);
  await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
  await IntegrationConnection.update({ lastSecretRotationAt: new Date(agora - dias * DIA) }, { where: { id: c.id }, transaction });
  return { c: await registry.getConnection(c.id, ctx, transaction), store };
}

test('secret_bank_rotacao_90_dias_obrigatoria', async () => {
  await comAgora(async (transaction) => {
    secrets.registerSecretIncidentReporter(async () => {});
    // 91 dias: vencido, vai a AUTH_FAILED, sempre.
    const velha = await bankComIdade(transaction, 91);
    const r = await secrets.enforceSecretExpiry(velha.c, ctx, transaction, { store: velha.store, now: agora });
    assert.equal(r.state, 'EXPIRED');
    assert.equal(r.alert, 'VENCIDA');
    assert.equal((await registry.getConnection(velha.c.id, ctx, transaction)).status, 'AUTH_FAILED');
    // Exatamente 90 dias: alerta de vencido, mas a connection ainda opera.
    const limite = await bankComIdade(transaction, 90);
    const l = await secrets.enforceSecretExpiry(limite.c, ctx, transaction, { store: limite.store, now: agora });
    assert.equal(l.state, 'EXPIRED_ALERT');
    assert.equal(l.alert, 'VENCIDA');
    assert.equal(l.transitioned, false);
    assert.equal((await registry.getConnection(limite.c.id, ctx, transaction)).status, 'ACTIVE');
    // O limite de 90 dias é parâmetro.
    await config(transaction, 'integration.secret.rotation_max_age_days.BANK', 30);
    const trinta = await bankComIdade(transaction, 31);
    assert.equal((await secrets.enforceSecretExpiry(trinta.c, ctx, transaction, { store: trinta.store, now: agora })).state, 'EXPIRED');
  });
});

test('secret_bank_rotacao_antes_de_90_dias_nao_alerta_e_mfa_na_mudanca', async () => {
  await comAgora(async (transaction) => {
    const nova = await bankComIdade(transaction, 89);
    const r = await secrets.enforceSecretExpiry(nova.c, ctx, transaction, { store: nova.store, now: agora });
    assert.notEqual(r.state, 'EXPIRED');
    assert.notEqual(r.state, 'EXPIRED_ALERT');
    assert.notEqual(r.alert, 'VENCIDA');
    assert.equal(r.alert, 'EXPIRANDO');
    assert.equal(r.alertDays, 7);
    assert.equal((await registry.getConnection(nova.c.id, ctx, transaction)).status, 'ACTIVE');
    const fresca = await bankComIdade(transaction, 10);
    const f = await secrets.evaluateConnectionSecret(fresca.c, { domain: 'BANK', store: fresca.store, now: agora, transaction, ctx });
    assert.equal(f.state, 'OK');
    assert.equal(f.alert, null);
    // Mudar o segredo de uma connection BANK exige MFA recente (o seed não tem MFA).
    await semMfa(tenant.userId, transaction); // hermético: outro arquivo pode ter deixado MFA habilitado para o usuário do seed
    await config(transaction, 'integration.secret.mfa_on_bank_secret_change', true);
    await assert.rejects(registry.updateConnection(nova.c.id, { secretRef: refDe('troca') }, ctx, transaction),
      (err) => ['MFA_REQUIRED_NOT_ENABLED', 'MFA_STEP_UP_REQUIRED'].includes(err.code));
    await assert.rejects(registry.createConnection(novaConexao({ secretRef: refDe('outra') }), ctx, transaction),
      (err) => ['MFA_REQUIRED_NOT_ENABLED', 'MFA_STEP_UP_REQUIRED'].includes(err.code));
    // Desligado pelo administrador, passa; connection que não é BANK nunca pede.
    await config(transaction, 'integration.secret.mfa_on_bank_secret_change', false);
    await registry.updateConnection(nova.c.id, { secretRef: refDe('troca') }, ctx, transaction);
    await config(transaction, 'integration.secret.mfa_on_bank_secret_change', true);
    await registry.createConnection(novaConexao({ providerCode: 'email-sandbox', secretRef: refDe('email') }), ctx, transaction);
  });
});

test('rotacao_da_connection_v1_para_v2_com_auditoria_sem_valor', async () => {
  await comAgora(async (transaction) => {
    await config(transaction, 'integration.secret.mfa_on_bank_secret_change', false);
    const { c, store } = await criarComSegredo(transaction);
    const r = await secrets.rotateConnectionSecret(c.id, {
      newValue: 'valor-novo-QA-M9-zzzzzz',
      testConnection: async ({ value }) => value.reveal() === 'valor-novo-QA-M9-zzzzzz',
    }, ctx, transaction, { store, now: agora });
    assert.equal(r.previousVersion, 1);
    assert.equal(r.version, 2);
    assert.equal(new Date(r.graceUntil).getTime(), agora + 30 * 60 * 1000);
    assert.ok(!JSON.stringify(r).includes('valor-novo-QA-M9'));
    const depois = await registry.getConnection(c.id, ctx, transaction);
    assert.ok(depois.lastSecretRotationAt);
    const linhas = await AuditLog.findAll({ where: { action: 'integration.secret.rotated', entityId: c.id }, transaction });
    assert.equal(linhas.length, 1);
    assert.deepEqual([linhas[0].afterJson.fromVersion, linhas[0].afterJson.toVersion], [1, 2]);
    assert.ok(!JSON.stringify(linhas[0].toJSON()).includes('valor-novo-QA-M9'));
    // O dispatch seguinte já usa a versão nova (cache invalidado pela rotação).
    const lido = await secrets.readConnectionSecret(depois, ctx, { purpose: 'dispatch', transaction, store, now: agora });
    assert.equal(lido.value.reveal(), 'valor-novo-QA-M9-zzzzzz');
    // Falha no teste: 422, versão anterior segue, nada novo na trilha.
    await recusa(secrets.rotateConnectionSecret(c.id, { newValue: 'valor-ruim-QA-M9-yyyyyy', testConnection: async () => false }, ctx, transaction, { store, now: agora }), 'INTEGRATION_SECRET_ROTATION_FAILED', 422);
    assert.equal((await store.describe(depois.secretRef)).version, 2);
    // Janela de graça configurável.
    await config(transaction, 'integration.secret.grace_period_min', 5);
    const r3 = await secrets.rotateConnectionSecret(c.id, { newValue: 'valor-tres-QA-M9-xxxxxx', testConnection: async () => true }, ctx, transaction, { store, now: agora });
    assert.equal(new Date(r3.graceUntil).getTime(), agora + 5 * 60 * 1000);
    // Sem referência: 404 de segredo.
    const sem = await registry.createConnection(novaConexao({ providerCode: 'email-sandbox' }), ctx, transaction);
    await recusa(secrets.rotateConnectionSecret(sem.id, { newValue: 'valor-qualquer-QA-M9-1', testConnection: async () => true }, ctx, transaction, { store, now: agora }), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  });
});

test('parametros_do_cofre_no_settings_schema_e_lidos', async () => {
  await comAgora(async (transaction) => {
    for (const [chave, bom, ruim] of [
      ['integration.secret.cache_ttl_s', 30, -1],
      ['integration.secret.grace_period_min', 10, 'dez'],
      ['integration.secret.rotation_max_age_days.BANK', 60, 0],
      ['integration.secret.expiry_alert_days', '45,20,5', '10,abc'],
      ['integration.secret.require_company_prefix', false, 'sim'],
      ['integration.secret.mfa_on_bank_secret_change', false, 1],
    ]) {
      await config(transaction, chave, bom);
      await assert.rejects(config(transaction, chave, ruim), (err) => err.code === 'SETTING_INVALID_VALUE', chave);
    }
    // Alertas de expiração configuráveis alteram o aviso.
    const fresca = await bankComIdade(transaction, 60 - 4);
    const r = await secrets.evaluateConnectionSecret(fresca.c, { domain: 'BANK', store: fresca.store, now: agora, transaction, ctx });
    assert.equal(r.alert, 'EXPIRANDO');
    assert.equal(r.alertDays, 5);
  });
});
