'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const documentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../src/features/correspondent/cases/submissions.service');
const webhooksService = require('../src/features/correspondent/webhooks.service');
const settingsService = require('../src/features/settings/settings.service');
const { Person, File, FinancingCase } = require('../src/models');

// Testes de PROCESSAMENTO DE WEBHOOK (ao contrário dos outros arquivos de teste de correspondent,
// que usam withRollbackTenantTransaction): `processFinancingWebhook` abre sua PRÓPRIA transação
// real (é assim que um webhook público funciona de verdade — não tem uma transação de request já
// aberta pra entrar), por isso o setup aqui usa `withTenantTransaction` (commit de verdade) e o
// cleanup explícito no `after()` apaga tudo que foi criado.

let tenant;
const createdFinancingCaseIds = [];

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  // Cleanup explícito — FinancingCase cascateia case_applicants/requirements/documents/
  // simulations/submissions/status_history/webhook_inbox (todas FK ON DELETE CASCADE), mas
  // `external_case_routing` não tem FK (ver migration 20260101000345), precisa de DELETE manual.
  if (createdFinancingCaseIds.length > 0) {
    await sequelize.query('DELETE FROM correspondent.external_case_routing WHERE financing_case_id = ANY(ARRAY[:ids]::uuid[])', {
      replacements: { ids: createdFinancingCaseIds },
    });
    await FinancingCase.destroy({ where: { id: createdFinancingCaseIds } });
  }
  await sequelize.close();
});

async function setWebhookSecret(secret) {
  await withTenantTransaction(tenant, (t) =>
    settingsService.upsertSetting('correspondent.sandbox_webhook_secret', secret, tenant, tenant.userId, t)
  );
}

async function createSubmittedCase() {
  let financingCaseId;
  await withTenantTransaction(tenant, async (transaction) => {
    const principal = await Person.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Proponente Webhook ${uniqueSuffix()}`,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      transaction
    );
    financingCaseId = financingCase.id;

    const requirement = await documentsService.createRequirement(
      financingCase.id,
      { documentType: 'RG_CPF', required: true },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    const file = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: `rg-cpf-${uniqueSuffix()}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        storageKey: `test/${uniqueSuffix()}.pdf`,
        uploadedByUserId: tenant.userId,
      },
      { transaction }
    );
    await documentsService.uploadDocument(
      financingCase.id,
      requirement.id,
      { fileId: file.id },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
  });

  const submission = await withTenantTransaction(tenant, (transaction) =>
    submissionsService.submitFinancingCase(financingCaseId, { amount: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction)
  );
  assert.equal(submission.status, 'SUBMITTED', 'pré-condição do teste: submissão precisa ter sucedido');

  createdFinancingCaseIds.push(financingCaseId);
  return { financingCaseId, externalCaseId: submission.externalCaseId };
}

function signedWebhookRequest(secret, body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, headers: { 'x-webhook-signature': `sha256=${signature}` } };
}

test('CORRESPONDENT-WEBHOOK-01: webhook válido aplica status, grava histórico raw+normalizado', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);

  const result = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(result.processed, true);
  assert.equal(result.applied, true);
  assert.equal(result.normalizedStatus, 'UNDER_ANALYSIS');

  await withTenantTransaction(tenant, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(financingCase.status, 'UNDER_ANALYSIS');

    const { history } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(history.length, 1);
    assert.equal(history[0].rawProviderStatus, 'ANALYSIS');
    assert.equal(history[0].normalizedStatus, 'UNDER_ANALYSIS');
    assert.equal(history[0].applied, true);
  });
});

test('CORRESPONDENT-WEBHOOK-02: webhook com assinatura inválida é rejeitado e não altera nada', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const rawBody = Buffer.from(JSON.stringify(body));

  await assert.rejects(
    () => webhooksService.processFinancingWebhook('sandbox', rawBody, { 'x-webhook-signature': 'sha256=' + 'a'.repeat(64) }, body),
    (err) => err.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID'
  );

  await withTenantTransaction(tenant, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(financingCase.status, 'SUBMITTED', 'status não pode ter mudado com assinatura inválida');
    const { history } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(history.length, 0, 'nenhum histórico deve ser gravado quando a assinatura é rejeitada');
  });
});

test('CORRESPONDENT-WEBHOOK-03: webhook duplicado (mesmo externalEventId) aplica o efeito uma única vez', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const externalEventId = `evt-${uniqueSuffix()}`;
  const body = { externalCaseId, externalEventId, status: 'ANALYSIS' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);

  const first = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(first.processed, true);

  const second = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(second.processed, false);
  assert.equal(second.reason, 'duplicate_event');

  await withTenantTransaction(tenant, async (transaction) => {
    const { history } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(history.length, 1, 'webhook duplicado não pode gerar uma segunda linha de histórico');
  });
});

test('CORRESPONDENT-WEBHOOK-04: status fora de ordem não regride o case, mas fica registrado no histórico', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  // Avança até APPROVED primeiro.
  const advance = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' };
  const req1 = signedWebhookRequest(secret, advance);
  await webhooksService.processFinancingWebhook('sandbox', req1.rawBody, req1.headers, advance);

  // Evento atrasado de uma fase anterior (ANALYSIS -> UNDER_ANALYSIS) chega depois.
  const late = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const req2 = signedWebhookRequest(secret, late);
  const result = await webhooksService.processFinancingWebhook('sandbox', req2.rawBody, req2.headers, late);

  assert.equal(result.processed, true);
  assert.equal(result.applied, false, 'evento fora de ordem não pode ser aplicado');

  await withTenantTransaction(tenant, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(financingCase.status, 'APPROVED', 'case não pode regredir pra UNDER_ANALYSIS');

    const { history } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(history.length, 2, 'o evento fora de ordem ainda precisa aparecer no histórico (nunca perder o raw status)');
    const ignoredEntry = history.find((h) => h.rawProviderStatus === 'ANALYSIS');
    assert.ok(ignoredEntry);
    assert.equal(ignoredEntry.applied, false);
    assert.equal(ignoredEntry.normalizedStatus, 'UNDER_ANALYSIS');
  });
});

test('CORRESPONDENT-WEBHOOK-05: mapa de status do sandbox normaliza corretamente cada valor do Caderno', () => {
  const { SandboxFinancingProviderAdapter } = require('../src/features/correspondent/adapters/FinancingProviderAdapter');
  const adapter = new SandboxFinancingProviderAdapter();
  assert.equal(adapter.normalizeProviderStatus('RECEIVED'), 'SUBMITTED');
  assert.equal(adapter.normalizeProviderStatus('ANALYSIS'), 'UNDER_ANALYSIS');
  assert.equal(adapter.normalizeProviderStatus('DOC_PENDING'), 'PENDING_CUSTOMER');
  assert.equal(adapter.normalizeProviderStatus('APPROVED'), 'APPROVED');
  assert.equal(adapter.normalizeProviderStatus('DENIED'), 'REJECTED');
  assert.equal(adapter.normalizeProviderStatus('CONTRACTED'), 'COMPLETED');
  assert.equal(adapter.normalizeProviderStatus('ALGO_DESCONHECIDO'), null);
});

test('CORRESPONDENT-WEBHOOK-06: provider desconhecido na URL retorna processed:false sem lançar erro', async () => {
  const body = { externalCaseId: 'nao-importa', externalEventId: 'evt-x', status: 'APPROVED' };
  const result = await webhooksService.processFinancingWebhook('banco-inexistente', Buffer.from('{}'), {}, body);
  assert.equal(result.processed, false);
  assert.equal(result.reason, 'unknown_provider');
});

test('CORRESPONDENT-WEBHOOK-07: externalCaseId desconhecido (roteamento) não lança erro, só não processa', async () => {
  const body = { externalCaseId: `inexistente-${uniqueSuffix()}`, externalEventId: 'evt-x', status: 'APPROVED' };
  const result = await webhooksService.processFinancingWebhook('sandbox', Buffer.from('{}'), {}, body);
  assert.equal(result.processed, false);
  assert.equal(result.reason, 'unknown_routing');
});

test('CORRESPONDENT-WEBHOOK-08: payload sem campo obrigatório é rejeitado como invalid_payload', async () => {
  const result = await webhooksService.processFinancingWebhook('sandbox', Buffer.from('{}'), {}, { externalCaseId: 'x' });
  assert.equal(result.processed, false);
  assert.equal(result.reason, 'invalid_payload');
});

test('CORRESPONDENT-WEBHOOK-09: GET status isola por empresa (RLS) — case de outra empresa não aparece', async () => {
  const { externalCaseId } = await createSubmittedCase();
  void externalCaseId;

  const [[otherCompanyRow]] = await sequelize.query('SELECT id, group_id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  if (!otherCompanyRow) return; // ambiente sem segunda empresa semeada — não é o foco deste teste

  const otherTenant = { groupId: otherCompanyRow.group_id, companyId: otherCompanyRow.id, userId: tenant.userId };
  await assert.rejects(
    () =>
      withTenantTransaction(otherTenant, (transaction) =>
        webhooksService.getCaseStatus(
          createdFinancingCaseIds[createdFinancingCaseIds.length - 1],
          otherTenant.groupId,
          otherTenant.companyId,
          transaction
        )
      ),
    (err) => err.code === 'FINANCING_CASE_NOT_FOUND'
  );
});

test('CORRESPONDENT-WEBHOOK-10: status terminal não flipa pro irmão oposto (REJECTED não vira APPROVED, COMPLETED não vira CANCELED)', () => {
  const { shouldApplyTransition } = require('../src/features/correspondent/statusMachine');
  assert.equal(shouldApplyTransition('REJECTED', 'APPROVED'), false);
  assert.equal(shouldApplyTransition('APPROVED', 'REJECTED'), false);
  assert.equal(shouldApplyTransition('COMPLETED', 'CANCELED'), false);
  assert.equal(shouldApplyTransition('CANCELED', 'COMPLETED'), false);
  // Movimentos laterais legítimos (mesmo rank, não são decisão terminal oposta) continuam livres.
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'PENDING_CUSTOMER'), true);
  assert.equal(shouldApplyTransition('PENDING_CUSTOMER', 'PENDING_PROPERTY'), true);
  // Progresso normal continua funcionando.
  assert.equal(shouldApplyTransition('SUBMITTED', 'UNDER_ANALYSIS'), true);
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'APPROVED'), true);
});
