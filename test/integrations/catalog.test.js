'use strict';

// Marco 9, M9-D201 — catálogo inicial das 14 integrações (providers sandbox, capabilities, criticidade).
// As expectativas abaixo são a TABELA DO LIVRO escrita à mão (não lida de catalog.js), para que o teste
// prove o banco e o código contra o livro. Roda em banco descartável (withDisposableDb).

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { IntegrationProvider, IntegrationConnection, ProviderAccount } = require('../../src/models');
const registry = require('../../src/features/integrations/registry/registry.service');
const settingsService = require('../../src/features/settings/settings.service');
const catalog = require('../../src/features/integrations/providers/catalog');
const { seedCatalog } = require('../../src/features/integrations/providers/catalog.seed');
const { listCatalog } = require('../../src/features/integrations/providers/catalog.service');
const contingency = require('../../src/features/integrations/providers/contingency.registry');

// Tabela da seção 3.1 da demanda (livro, seção 3 do caderno).
const LIVRO = {
  MESSAGING: ['messaging-sandbox', 'HIGH', ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']],
  EMAIL: ['email-sandbox', 'MEDIUM', ['sendEmail', 'getDeliveryStatus', 'receiveInbound']],
  SITE: ['site-sandbox', 'MEDIUM', ['publishPage', 'unpublishPage', 'getPageStatus']],
  PORTAL: ['portal-sandbox', 'MEDIUM', ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']],
  SIGNATURE: ['signature-sandbox', 'CRITICAL', ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook']],
  BANK: ['bank-sandbox', 'CRITICAL', ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook']],
  INSURANCE: ['insurance-sandbox', 'HIGH', ['quote', 'propose', 'getPolicy', 'getStatus', 'submitClaim', 'verifyWebhook']],
  FINANCING: ['financing-sandbox', 'CRITICAL', ['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal']],
  FISCAL: ['fiscal-sandbox', 'HIGH', ['issueNfse', 'getNfseStatus', 'cancelNfse']],
  SOCIAL: ['social-sandbox', 'LOW', ['publishPost', 'getPostStatus', 'deletePost']],
  STORAGE: ['storage-sandbox', 'HIGH', ['putObject', 'getObject', 'deleteObject', 'headObject']],
  IDENTITY: ['identity-sandbox', 'CRITICAL', ['verifyToken', 'getUserInfo', 'revokeSession']],
  AI: ['ai-sandbox', 'MEDIUM', ['generate', 'embed', 'transcribe', 'analyzeImage']],
  ANALYTICS: ['analytics-sandbox', 'LOW', ['emitMetric', 'emitEvent', 'queryHealth']],
};

let tenant;
let ctx;

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
});

afterEach(() => contingency.clearContingencyHandlers());

after(async () => {
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query(`DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'integration.catalog.%'`, { replacements: { c: tenant.companyId }, transaction: t });
  });
  await sequelize.close();
});

async function comPlataforma(transaction) {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
}

async function recusa(promessa, code, status) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode ?? err.status, status);
    return true;
  });
}

const ordenado = (lista) => [...lista].sort();

test('catalogo_seed_14_dominios', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const [domain, [code, criticidade, capabilities]] of Object.entries(LIVRO)) {
      const p = await IntegrationProvider.findByPk(code, { transaction });
      assert.ok(p, `${code} deve existir`);
      assert.equal(p.domain, domain);
      assert.equal(p.criticality, criticidade, `${code} criticidade`);
      assert.equal(p.status, 'ACTIVE');
      assert.equal(p.sandboxAvailable, true);
      const esperado = domain === 'FINANCING' ? [...capabilities, 'verifyWebhook'] : capabilities;
      assert.deepEqual(ordenado(p.capabilities), ordenado(esperado), `${code} capabilities`);
    }
    const sandboxes = await IntegrationProvider.findAll({ where: { code: Object.values(LIVRO).map((v) => v[0]) }, transaction });
    assert.equal(sandboxes.length, 14);
    assert.equal(new Set(sandboxes.map((s) => s.domain)).size, 14);
    // O código (fonte de verdade da lista) bate com o livro.
    assert.deepEqual(ordenado(catalog.DOMAINS), ordenado(Object.keys(LIVRO)));
    for (const [domain, [, , capabilities]] of Object.entries(LIVRO)) {
      for (const c of capabilities) assert.ok(catalog.DOMAIN_CAPABILITIES[domain].includes(c), `${domain}.${c}`);
    }
  });
});

test('catalogo_seed_idempotente_preserva_status', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await comPlataforma(transaction);
    await sequelize.query(
      `UPDATE integration.providers SET status = 'DISABLED', default_policy_json = '{"qa":"admin"}'::jsonb,
              display_name = 'adulterado', capabilities = '["x"]'::jsonb, supported_versions = '["v9"]'::jsonb
        WHERE code = 'messaging-sandbox'`, { transaction });
    const antes = await IntegrationProvider.count({ transaction });
    const r1 = await seedCatalog(sequelize, transaction);
    const r2 = await seedCatalog(sequelize, transaction);
    assert.equal(await IntegrationProvider.count({ transaction }), antes, 'segunda execução não duplica');
    assert.equal(r2.inserted, 0);
    assert.ok(r1.total >= 14);
    const p = await IntegrationProvider.findByPk('messaging-sandbox', { transaction });
    assert.equal(p.status, 'DISABLED', 'status do administrador preservado');
    assert.deepEqual(p.defaultPolicyJson, { qa: 'admin' }, 'política do administrador preservada');
    assert.equal(p.displayName, 'Mensageria (WhatsApp e atendimento) — sandbox', 'nome volta ao do catálogo');
    assert.deepEqual(ordenado(p.capabilities), ordenado(LIVRO.MESSAGING[2]), 'capabilities voltam ao catálogo');
    assert.deepEqual(p.supportedVersions, ['v1']);
  });
});

test('catalogo_capabilities_por_dominio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const base = { displayName: 'QA-M9', supportedVersions: ['v1'], criticality: 'LOW', sandboxAvailable: true };
    const novo = (sufixo, over) => ({ code: `qa-m9-${sufixo}-${uniqueSuffix()}`.toLowerCase(), domain: 'MESSAGING', capabilities: ['sendText'], ...base, ...over });
    await recusa(registry.createProvider(novo('cap', { capabilities: ['sendText', 'issueNfse'] }), ctx, transaction), 'INTEGRATION_CAPABILITY_INVALID', 422);
    await recusa(registry.createProvider(novo('dom', { domain: 'XPTO' }), ctx, transaction), 'INTEGRATION_DOMAIN_INVALID', 422);
    const ok = await registry.createProvider(novo('ok', { capabilities: ['sendText', 'getStatus'] }), ctx, transaction);
    assert.deepEqual(ok.capabilities, ['sendText', 'getStatus']);
    // Alteração: capability fora do domínio atual é recusada; trocar o domínio revalida as capabilities.
    await recusa(registry.updateProvider(ok.code, { capabilities: ['issueNfse'] }, ctx, transaction), 'INTEGRATION_CAPABILITY_INVALID', 422);
    await recusa(registry.updateProvider(ok.code, { domain: 'FISCAL' }, ctx, transaction), 'INTEGRATION_CAPABILITY_INVALID', 422);
    const trocado = await registry.updateProvider(ok.code, { domain: 'FISCAL', capabilities: ['issueNfse'] }, ctx, transaction);
    assert.equal(trocado.domain, 'FISCAL');
    // As operações extras dos ports de outras demandas já são aceitas no domínio (D236, D239, D240, D242).
    assert.ok(catalog.DOMAIN_CAPABILITIES.SIGNATURE.includes('downloadSigned'));
    assert.ok(catalog.DOMAIN_CAPABILITIES.SOCIAL.includes('findPostByKey'));
    assert.ok(catalog.DOMAIN_CAPABILITIES.FINANCING.includes('cancelCase'));
    assert.ok(catalog.DOMAIN_CAPABILITIES.STORAGE.includes('getSignedUrl'));
    assert.ok(catalog.DOMAIN_CAPABILITIES.IDENTITY.includes('listJwks'));
  });
});

test('catalogo_providers_existentes_migrados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const esperados = {
      'financing-sandbox': 'FINANCING', 'financing-manual': 'FINANCING', 'insurance-sandbox': 'INSURANCE',
      'signature-clicksign': 'SIGNATURE', 'bank-sandbox': 'BANK', 'fiscal-sandbox': 'FISCAL',
    };
    for (const [code, domain] of Object.entries(esperados)) {
      const p = await IntegrationProvider.findByPk(code, { transaction });
      assert.ok(p, `${code} no catálogo`);
      assert.equal(p.domain, domain);
    }
    // Os códigos antigos não existem mais: viraram os novos (connections seguem o código por UPDATE CASCADE).
    assert.equal(await IntegrationProvider.count({ where: { code: ['sandbox', 'manual'] }, transaction }), 0);
    // Os 5 adapters existentes estão mapeados e o provider do catálogo existe para cada um.
    assert.equal(new Set(catalog.LEGACY_ADAPTERS.map((a) => a.file)).size, 5, 'os 5 arquivos de adapter existentes');
    for (const a of catalog.LEGACY_ADAPTERS) {
      const modulo = require(`../../${a.file}`);
      assert.equal(typeof modulo[a.className], 'function', `${a.className} existe em ${a.file}`);
      assert.ok(await IntegrationProvider.findByPk(a.providerCode, { transaction }), `${a.providerCode} cadastrado`);
    }
    // O Correspondente fala "sandbox"/"manual"; o catálogo fala "financing-sandbox"/"financing-manual".
    assert.equal(catalog.toCatalogCode('sandbox'), 'financing-sandbox');
    assert.equal(catalog.toCatalogCode('manual'), 'financing-manual');
    assert.equal(catalog.toCatalogCode('financing-sandbox'), 'financing-sandbox');
    assert.equal(catalog.toCorrespondentCode('financing-manual'), 'manual');
    // Conta legada com o código antigo migra para o código novo.
    await sequelize.query("SET LOCAL app.integration_legacy_write = 'on'", { transaction });
    const conta = await ProviderAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'manual', label: `QA-M9 ${uniqueSuffix()}`, secretRef: 'vault:qa-m9/x', active: true }, { transaction });
    await registry.migrateLegacyProviderAccounts(ctx, transaction);
    assert.equal((await IntegrationConnection.findByPk(conta.id, { transaction })).providerCode, 'financing-manual');
  });
});

test('catalogo_dominio_sem_connection_aciona_contingencia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const chamadas = [];
    contingency.registerContingencyHandler('MESSAGING', async (info) => { chamadas.push(info); });
    // Sem connection ativa: 404 com o código do livro e a contingência é acionada com o contexto.
    await recusa(registry.resolveConnection({ companyId: tenant.companyId, domain: 'MESSAGING' }, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].domain, 'MESSAGING');
    assert.equal(chamadas[0].companyId, tenant.companyId);
    // Família sem modo de contingência registrado: o mesmo 404, nunca 500.
    await recusa(registry.resolveConnection({ companyId: tenant.companyId, domain: 'SOCIAL' }, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    assert.equal(chamadas.length, 1);
    // Defeito na contingência não vira 500.
    contingency.registerContingencyHandler('EMAIL', async () => { throw new Error('falha simulada'); });
    await recusa(registry.resolveConnection({ companyId: tenant.companyId, domain: 'EMAIL' }, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    // Domínio fora da lista: 422 próprio.
    await recusa(registry.resolveConnection({ companyId: tenant.companyId, domain: 'XPTO' }, transaction), 'INTEGRATION_DOMAIN_INVALID', 422);
    // Com connection ativa, nada é acionado.
    const c = await registry.createConnection({ providerCode: 'messaging-sandbox', environment: registry.getServerEnvironment(), label: `QA-M9 ${uniqueSuffix()}` }, ctx, transaction);
    await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    const r = await registry.resolveConnection({ companyId: tenant.companyId, domain: 'MESSAGING' }, transaction);
    assert.equal(r.id, c.id);
    assert.equal(chamadas.length, 1);
  });
});

test('catalogo_listagem_admin_14_dominios_e_criticidade_configuravel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const lista = await listCatalog(ctx, transaction);
    assert.equal(lista.domains.length, 14);
    for (const d of lista.domains) {
      const [code, criticidade, capabilities] = LIVRO[d.domain];
      assert.equal(d.criticality, criticidade);
      assert.equal(d.defaultCriticality, criticidade);
      assert.ok(d.providers.some((p) => p.code === code && p.sandboxAvailable));
      assert.ok(capabilities.every((c) => d.capabilities.includes(c)));
      assert.equal(d.contingencyRequired, criticidade === 'CRITICAL');
      assert.equal(d.activeConnections, 0);
    }
    // O administrador muda a criticidade da família; o valor inválido cai no padrão (falha fechada).
    const chave = 'integration.catalog.criticality.social';
    assert.equal(settingsService.SETTINGS_SCHEMA[chave].type, 'string');
    await settingsService.upsertSetting(chave, 'HIGH', tenant, tenant.userId, transaction);
    assert.equal((await listCatalog(ctx, transaction)).domains.find((d) => d.domain === 'SOCIAL').criticality, 'HIGH');
    await sequelize.query("UPDATE core.tenant_settings SET value = '\"EXTREME\"'::jsonb WHERE key = :k AND company_id = :c", { transaction, replacements: { k: chave, c: tenant.companyId } });
    assert.equal((await listCatalog(ctx, transaction)).domains.find((d) => d.domain === 'SOCIAL').criticality, 'LOW');
    await assert.rejects(settingsService.upsertSetting(chave, 'EXTREME', tenant, tenant.userId, transaction), (e) => e.code === 'SETTING_INVALID_VALUE');
    for (const dominio of Object.keys(LIVRO)) {
      assert.ok(settingsService.SETTINGS_SCHEMA[`integration.catalog.criticality.${dominio.toLowerCase()}`], dominio);
    }
  });
});

test('catalogo_rota_get_admin_integrations_catalog_protegida', () => {
  const router = require('../../src/features/integrations/providers/catalog.routes');
  const camada = router.stack.find((l) => l.route && l.route.path === '/admin/integrations/catalog' && l.route.methods.get);
  assert.ok(camada, 'GET /admin/integrations/catalog montada');
  assert.ok(camada.route.stack.length >= 2, 'com a porta de permissão antes do controller');
});
