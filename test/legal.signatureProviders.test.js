'use strict';

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const settingsService = require('../src/features/settings/settings.service');
const signaturesService = require('../src/features/legal/signatures.service');
const { TenantSetting, File } = require('../src/models');
const legalController = require('../src/features/legal/legal.controller');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const peopleService = require('../src/features/people/people.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- resolução de adapter conforme legal.signature_provider ---
test('signatures: resolveSignatureAdapter usa Sandbox por padrão (sem configuração)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const adapter = await signaturesService.resolveSignatureAdapter(tenant, transaction);
    assert.equal(adapter.constructor.name, 'SandboxSignatureAdapter');
  });
});

test('signatures: resolveSignatureAdapter cai para Sandbox (fallback seguro) quando provider=clicksign mas SEM token configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('legal.signature_provider', 'clicksign', tenant, tenant.userId, transaction);
    const adapter = await signaturesService.resolveSignatureAdapter(tenant, transaction);
    assert.equal(adapter.constructor.name, 'SandboxSignatureAdapter');
  });
});

test('signatures: resolveSignatureAdapter monta ClicksignSignatureAdapter quando provider=clicksign COM token configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('legal.signature_provider', 'clicksign', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('legal.clicksign_api_token', 'fake-token-123', tenant, tenant.userId, transaction);
    const adapter = await signaturesService.resolveSignatureAdapter(tenant, transaction);
    assert.equal(adapter.constructor.name, 'ClicksignSignatureAdapter');
  });
});

test('signatures: resolveSignatureAdapter monta ZapSignSignatureAdapter quando provider=zapsign COM token configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('legal.signature_provider', 'zapsign', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('legal.zapsign_api_token', 'fake-token-456', tenant, tenant.userId, transaction);
    const adapter = await signaturesService.resolveSignatureAdapter(tenant, transaction);
    assert.equal(adapter.constructor.name, 'ZapSignSignatureAdapter');
  });
});

// --- token de provedor é armazenado criptografado, nunca em texto plano ---
test('settings: token de provedor de assinatura é armazenado criptografado no banco (nunca texto plano)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const plainToken = 'super-secret-clicksign-token';
    const row = await settingsService.upsertSetting('legal.clicksign_api_token', plainToken, tenant, tenant.userId, transaction);

    // O valor persistido na linha NUNCA é igual ao texto plano.
    assert.notEqual(row.value, plainToken);
    assert.ok(String(row.value).includes(':'), 'formato esperado iv:authTag:cipherText');

    // Lendo direto do banco (fora do service) confirma que não há texto plano na coluna.
    const rawRow = await TenantSetting.findOne({ where: { id: row.id }, transaction });
    assert.notEqual(rawRow.value, plainToken);
    assert.ok(!String(rawRow.value).includes(plainToken));

    // getDecryptedSetting recupera o valor original.
    const decrypted = await settingsService.getDecryptedSetting('legal.clicksign_api_token', tenant, transaction, null);
    assert.equal(decrypted, plainToken);

    // getSetting "cru" (sem decifrar) nunca deve devolver o texto plano.
    const rawGet = await settingsService.getSetting('legal.clicksign_api_token', tenant, transaction, null);
    assert.notEqual(rawGet, plainToken);
  });
});

// --- webhook: validação de HMAC ---
test('legal webhook: verifyProviderWebhookSignature aceita HMAC válido e rejeita ausente/errado (timing-safe)', () => {
  const secret = 'webhook-secret-abc';
  const rawBody = Buffer.from(JSON.stringify({ event: 'signed' }));
  // Esquema real do Clicksign (confirmado contra webhooks reais, 22/09/2026): HMAC-SHA256(key=secret),
  // igual ao ZapSign — ver legal.controller.js.
  const validClicksignHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const validZapsignHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(
    legalController.verifyProviderWebhookSignature('clicksign', rawBody, { 'content-hmac': `sha256=${validClicksignHex}` }, secret),
    true
  );
  assert.equal(
    legalController.verifyProviderWebhookSignature('clicksign', rawBody, { 'content-hmac': `sha256=${'a'.repeat(64)}` }, secret),
    false
  );
  assert.equal(legalController.verifyProviderWebhookSignature('clicksign', rawBody, {}, secret), false);
  assert.equal(
    legalController.verifyProviderWebhookSignature('clicksign', rawBody, { 'content-hmac': `sha256=${validClicksignHex}` }, null),
    false
  );
  assert.equal(
    legalController.verifyProviderWebhookSignature('zapsign', rawBody, { 'x-zapsign-signature': validZapsignHex }, secret),
    true
  );
});

async function createLeaseWithSignedContract(transaction) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 },
    tenant.userId,
    transaction
  );
  const person = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Signatário ${suffix}` },
    tenant.userId,
    transaction
  );
  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  await contractsService.addContractParty(contract.id, { personId: person.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
  // M5-07: criar versão de contrato agora exige o arquivo do documento já na criação
  // (default do tenant `legal.contract_version_requires_document` = true).
  const file = await File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `homo-qa/signatures/${suffix}.pdf`,
      fileName: `contrato-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content: `conteúdo do contrato de teste ${suffix}`, documentFileId: file.id },
    tenant.userId,
    transaction
  );
  await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);
  const [signature] = await signaturesService.initiateSignature(version.id, [person.id], tenant.userId, transaction);
  return signature;
}

function buildFakeReq({ params, body, headers }) {
  return {
    params,
    body,
    headers: headers || {},
    auth: { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId },
  };
}

function buildFakeRes(onDone) {
  return {
    status() {
      return this;
    },
    json(body) {
      if (onDone) onDone(body);
      return this;
    },
  };
}

// Invoca o controller (já envolto em catchAsync, que é "fire-and-forget" — não retorna a
// Promise interna) e resolve quando o fluxo termina, seja por sucesso (res.json) ou erro
// (next(err)), para os testes poderem aguardar o resultado de forma determinística.
function invokeController(controllerFn, req) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const res = buildFakeRes((body) => settle({ error: null, body }));
    controllerFn(req, res, (err) => settle({ error: err || null, body: null }));
  });
}

test('legal webhook: sandbox continua funcionando SEM exigir HMAC (nenhum provider real configurado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const signature = await createLeaseWithSignedContract(transaction);

    const req = buildFakeReq({ params: { externalSignatureId: signature.externalSignatureId }, body: {} });
    req.withTenantTransaction = (fn) => fn(transaction);

    const { error } = await invokeController(legalController.signatureWebhook, req);
    assert.equal(error, null);
  });
});

test('legal webhook: rejeita payload SEM HMAC válido quando há provider real (clicksign) configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('legal.signature_provider', 'clicksign', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('legal.clicksign_webhook_secret', 'real-webhook-secret', tenant, tenant.userId, transaction);

    const signature = await createLeaseWithSignedContract(transaction);

    const req = buildFakeReq({ params: { externalSignatureId: signature.externalSignatureId }, body: {}, headers: {} });
    req.withTenantTransaction = (fn) => fn(transaction);

    const { error } = await invokeController(legalController.signatureWebhook, req);
    assert.ok(error, 'esperava erro de HMAC inválido, mas o webhook foi processado');
    assert.equal(error.code, 'LEGAL_WEBHOOK_HMAC_INVALID');
    assert.equal(error.statusCode, 401);
  });
});

test('legal webhook: aceita quando o HMAC do corpo bruto é válido para o provider real configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const webhookSecret = 'real-webhook-secret-2';
    await settingsService.upsertSetting('legal.signature_provider', 'clicksign', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('legal.clicksign_webhook_secret', webhookSecret, tenant, tenant.userId, transaction);

    const signature = await createLeaseWithSignedContract(transaction);

    const bodyObj = {};
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const validHex = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    const req = buildFakeReq({
      params: { externalSignatureId: signature.externalSignatureId },
      body: bodyObj,
      headers: { 'content-hmac': `sha256=${validHex}` },
    });
    req.rawBody = rawBody;
    req.withTenantTransaction = (fn) => fn(transaction);

    const { error } = await invokeController(legalController.signatureWebhook, req);
    assert.equal(error, null);
  });
});
