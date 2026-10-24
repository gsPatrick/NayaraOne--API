'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const settingsService = require('../src/features/settings/settings.service');
const {
  verifyHmacSignature,
  SandboxFinancingProviderAdapter,
  ManualWorkflowFinancingProviderAdapter,
} = require('../src/features/correspondent/adapters/FinancingProviderAdapter');
const {
  resolveFinancingProviderAdapter,
  resolveFinancingProviderAdapterByCode,
} = require('../src/features/correspondent/adapters/resolveFinancingProviderAdapter');

// Marco 8 — Fase 0 do checklist de integração (MARCO_8_INTEGRACAO_CHECKLIST.md): só o
// ProviderAdapter (interface + registry + sandbox + manual). Nenhuma tabela financing_case
// existe ainda — tudo aqui é testável sem schema novo, só a Setting (tenant-scoped) já existente.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- Registry por tenant (settings) ---

test('correspondent ProviderAdapter: resolve sandbox por padrão sem nenhuma configuração', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const adapter = await resolveFinancingProviderAdapter(tenant, transaction);
    assert.ok(adapter instanceof SandboxFinancingProviderAdapter);
  });
});

test('correspondent ProviderAdapter: resolve manual quando configurado explicitamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('correspondent.financing_provider', 'manual', tenant, tenant.userId, transaction);
    const adapter = await resolveFinancingProviderAdapter(tenant, transaction);
    assert.ok(adapter instanceof ManualWorkflowFinancingProviderAdapter);
  });
});

// --- Registry por código (roteamento de webhook) ---

test('correspondent ProviderAdapter: registry por código resolve sandbox e manual, nega provider desconhecido', () => {
  assert.ok(resolveFinancingProviderAdapterByCode('sandbox') instanceof SandboxFinancingProviderAdapter);
  assert.ok(resolveFinancingProviderAdapterByCode('manual') instanceof ManualWorkflowFinancingProviderAdapter);
  assert.equal(resolveFinancingProviderAdapterByCode('banco_que_nao_existe'), null);
});

// --- SandboxFinancingProviderAdapter: determinístico, sem rede ---

test('correspondent ProviderAdapter: sandbox.simulate é determinístico e calcula parcela > 0', async () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const result = await adapter.simulate({ amount: 300000, termMonths: 360, idempotencyKey: 'fixo-1' });
  assert.equal(result.externalId, 'sandbox-sim-fixo-1');
  assert.ok(result.monthlyPayment > 0);
  assert.equal(result.installments, 360);
  assert.equal(result.raw.sandbox, true);
});

test('correspondent ProviderAdapter: sandbox.submitCase + getCaseStatus progride por tempo decorrido (SUBMITTED imediato)', async () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const submitted = await adapter.submitCase({ idempotencyKey: 'caso-1' });
  assert.equal(submitted.status, 'SUBMITTED');

  const statusImediato = await adapter.getCaseStatus(submitted.externalId);
  assert.equal(statusImediato.status, 'SUBMITTED');
  assert.equal(statusImediato.rawProviderStatus, 'SUBMITTED');
});

test('correspondent ProviderAdapter: sandbox.getCaseStatus reporta UNDER_ANALYSIS para um externalId "mais antigo"', async () => {
  const adapter = new SandboxFinancingProviderAdapter();
  // Constrói um externalId com timestamp 3s no passado (acima do threshold de 2s de UNDER_ANALYSIS,
  // abaixo do threshold de 6s de APPROVED) — sem precisar de sleep real no teste.
  const submittedAt = Date.now() - 3000;
  const externalId = `sandbox-case-teste-${submittedAt}`;
  const result = await adapter.getCaseStatus(externalId);
  assert.equal(result.status, 'UNDER_ANALYSIS');
});

test('correspondent ProviderAdapter: sandbox.getCaseStatus reporta APPROVED após o threshold', async () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const submittedAt = Date.now() - 7000;
  const externalId = `sandbox-case-teste-${submittedAt}`;
  const result = await adapter.getCaseStatus(externalId);
  assert.equal(result.status, 'APPROVED');
});

test('correspondent ProviderAdapter: sandbox capabilities reporta todos os métodos suportados', () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const caps = adapter.capabilities();
  assert.equal(caps.simulate, true);
  assert.equal(caps.submitCase, true);
  assert.equal(caps.getCaseStatus, true);
  assert.equal(caps.verifyWebhook, true);
});

// --- ManualWorkflowFinancingProviderAdapter: nunca faz chamada HTTP ---

test('correspondent ProviderAdapter: manual.submitCase nunca chama rede e retorna PENDING_MANUAL_ACTION', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch não deveria ser chamado pelo provider manual');
  };
  try {
    const adapter = new ManualWorkflowFinancingProviderAdapter();
    const result = await adapter.submitCase({ idempotencyKey: 'manual-1' });
    assert.equal(result.status, 'PENDING_MANUAL_ACTION');
    assert.equal(result.externalId, 'manual-manual-1');
    assert.equal(fetchCalled, false);

    const status = await adapter.getCaseStatus(result.externalId);
    assert.equal(status.status, 'PENDING_MANUAL_ACTION');
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('correspondent ProviderAdapter: manual.simulate não é suportado e lança erro de negócio claro', async () => {
  const adapter = new ManualWorkflowFinancingProviderAdapter();
  await assert.rejects(
    () => adapter.simulate({}),
    (err) => {
      assert.equal(err.code, 'CORRESPONDENT_PROVIDER_NOT_IMPLEMENTED');
      return true;
    }
  );
});

test('correspondent ProviderAdapter: manual capabilities reflete que simulate/verifyWebhook não são suportados', () => {
  const adapter = new ManualWorkflowFinancingProviderAdapter();
  const caps = adapter.capabilities();
  assert.equal(caps.simulate, false);
  assert.equal(caps.verifyWebhook, false);
  assert.equal(caps.submitCase, true);
});

test('correspondent ProviderAdapter: manual.verifyWebhook sempre nega (provider não tem webhook)', () => {
  const adapter = new ManualWorkflowFinancingProviderAdapter();
  assert.equal(adapter.verifyWebhook('{}', { 'x-webhook-signature': 'qualquer' }, 'secret'), false);
});

// --- verifyWebhook (HMAC) — mesmo padrão de segurança do webhook de seguro ---

test('correspondent ProviderAdapter: sandbox.verifyWebhook aceita assinatura HMAC válida', () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const secret = 'segredo-de-teste-sandbox';
  const rawBody = JSON.stringify({ externalCaseId: 'sandbox-case-x', status: 'APPROVED' });
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const valid = adapter.verifyWebhook(rawBody, { 'x-webhook-signature': signature }, secret);
  assert.equal(valid, true);
});

test('correspondent ProviderAdapter: sandbox.verifyWebhook rejeita assinatura inválida', () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const secret = 'segredo-de-teste-sandbox';
  const rawBody = JSON.stringify({ externalCaseId: 'sandbox-case-x', status: 'APPROVED' });
  const valid = adapter.verifyWebhook(rawBody, { 'x-webhook-signature': 'assinatura-forjada' }, secret);
  assert.equal(valid, false);
});

test('correspondent ProviderAdapter: sandbox.verifyWebhook rejeita quando o secret configurado é diferente do usado para assinar', () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const rawBody = JSON.stringify({ externalCaseId: 'sandbox-case-x', status: 'APPROVED' });
  const signature = crypto.createHmac('sha256', 'secret-A').update(rawBody).digest('hex');
  const valid = adapter.verifyWebhook(rawBody, { 'x-webhook-signature': signature }, 'secret-B');
  assert.equal(valid, false);
});

test('correspondent ProviderAdapter: sandbox.verifyWebhook rejeita sem header de assinatura', () => {
  const adapter = new SandboxFinancingProviderAdapter();
  const rawBody = JSON.stringify({ externalCaseId: 'sandbox-case-x', status: 'APPROVED' });
  const valid = adapter.verifyWebhook(rawBody, {}, 'segredo-qualquer');
  assert.equal(valid, false);
});

test('correspondent ProviderAdapter: verifyHmacSignature exportado é a mesma função usada pelos adapters', () => {
  const secret = 'segredo-compartilhado';
  const rawBody = '{"a":1}';
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(verifyHmacSignature(rawBody, { 'x-webhook-signature': signature }, secret), true);
  assert.equal(verifyHmacSignature(rawBody, { 'x-webhook-signature': signature }, 'secret-errado'), false);
});
