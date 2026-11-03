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
    await documentsService.validateRequirement(
      financingCase.id,
      requirement.id,
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
  });

  const submission = await withTenantTransaction(tenant, (transaction) =>
    submissionsService.submitFinancingCase(financingCaseId, { consent: true, amount: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction)
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

    const { history: historyAll } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    const history = historyAll.filter((h) => h.source === 'webhook');
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
    const { history: historyAll } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    const history = historyAll.filter((h) => h.source === 'webhook');
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
    const { history: historyAll } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    const history = historyAll.filter((h) => h.source === 'webhook');
    assert.equal(history.length, 1, 'webhook duplicado não pode gerar uma segunda linha de histórico');
  });
});

// Auditoria pós-DoD, Frente Idempotência/Concorrência — o WEBHOOK-03 acima prova dedup
// SEQUENCIAL (2ª chamada só começa depois da 1ª terminar). Isso NÃO prova nada sobre concorrência
// real: `processFinancingWebhook` abre sua PRÓPRIA transação internamente (sequelize.transaction
// auto-gerenciada), então duas entregas verdadeiramente simultâneas do mesmo evento (cenário real
// de provider reentregando por timeout de rede) usam 2 conexões/transações distintas, e podem
// passar pelo findOne de dedup antes de qualquer uma commitar.
test('CORRESPONDENT-WEBHOOK-11: duas entregas CONCORRENTES de verdade do mesmo evento (Promise.all, não sequencial) nunca duplicam histórico nem estouram erro cru', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const externalEventId = `evt-${uniqueSuffix()}`;
  const body = { externalCaseId, externalEventId, status: 'ANALYSIS' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);

  const resultados = await Promise.allSettled([
    webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body),
    webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body),
  ]);

  for (const r of resultados) {
    assert.equal(r.status, 'fulfilled', `nenhuma chamada pode rejeitar com erro técnico cru. Recebido: ${r.reason?.message || r.reason}`);
  }
  const processadas = resultados.filter((r) => r.value.processed === true);
  const duplicadas = resultados.filter((r) => r.value.reason === 'duplicate_event');
  assert.equal(processadas.length, 1, 'exatamente uma das duas entregas concorrentes deve processar o evento de verdade');
  assert.equal(duplicadas.length, 1, 'a outra deve voltar como duplicate_event, nunca um erro cru de violação de unicidade');

  await withTenantTransaction(tenant, async (transaction) => {
    const { history: historyAll } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    const history = historyAll.filter((h) => h.source === 'webhook');
    assert.equal(history.length, 1, 'mesmo sob concorrência real, nunca deve existir mais de 1 linha de histórico para o mesmo evento');
    const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(financingCase.status, 'UNDER_ANALYSIS', 'o status deve ter sido aplicado exatamente uma vez');
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

    const { history: historyAll } = await webhooksService.getCaseStatus(financingCaseId, tenant.groupId, tenant.companyId, transaction);
    const history = historyAll.filter((h) => h.source === 'webhook');
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

test('CORRESPONDENT-WEBHOOK-06: provider desconhecido na URL é recusado como assinatura inválida, sem revelar quais providers existem', async () => {
  const body = { externalCaseId: 'nao-importa', externalEventId: 'evt-x', status: 'APPROVED' };
  await assert.rejects(
    () => webhooksService.processFinancingWebhook('banco-inexistente', Buffer.from('{}'), {}, body),
    (err) => err.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID' && err.statusCode === 401 && err.rejectionReason === 'provider desconhecido na URL'
  );
});

test('CORRESPONDENT-WEBHOOK-07: externalCaseId desconhecido (roteamento) é recusado como assinatura inválida, sem revelar que o id não existe', async () => {
  const body = { externalCaseId: `inexistente-${uniqueSuffix()}`, externalEventId: 'evt-x', status: 'APPROVED' };
  // Mesma resposta de assinatura inválida: ninguém descobre, sem assinar, quais ids de caso existem.
  await assert.rejects(
    () => webhooksService.processFinancingWebhook('sandbox', Buffer.from('{}'), {}, body),
    (err) => err.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID'
  );
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

test('CORRESPONDENT-WEBHOOK-PROPOSTA-01: aprovação do provider com proposta grava a proposta vigente; proposta inválida vira erro de integração sem derrubar o status', async () => {
  const { FinancingProposal, IntegrationError } = require('../src/models');
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const valido = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED', proposal: { approvedAmount: 180000, annualRatePct: 9.9, termMonths: 240, monthlyPayment: 1850.4 } };
  const r1 = signedWebhookRequest(secret, valido);
  const res1 = await webhooksService.processFinancingWebhook('sandbox', r1.rawBody, r1.headers, valido);
  assert.equal(res1.applied, true);

  const invalido = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'CONTRACTING', proposal: { approvedAmount: -1, termMonths: 240 } };
  const r2 = signedWebhookRequest(secret, invalido);
  const res2 = await webhooksService.processFinancingWebhook('sandbox', r2.rawBody, r2.headers, invalido);
  assert.equal(res2.applied, true, 'o status é aplicado mesmo com a proposta malformada');

  await withTenantTransaction(tenant, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(financingCase.status, 'CONTRACTING');
    const propostas = await FinancingProposal.findAll({ where: { financingCaseId }, transaction });
    assert.equal(propostas.length, 1);
    assert.equal(propostas[0].source, 'PROVIDER');
    assert.equal(propostas[0].status, 'ACTIVE');
    assert.equal(Number(propostas[0].approvedAmount), 180000);
    const erros = await IntegrationError.findAll({ where: { financingCaseId, operation: 'webhook.proposal' }, transaction });
    assert.equal(erros.length, 1);
    assert.equal(erros[0].errorCode, 'PROPOSAL_VALIDATION');
    // eslint-disable-next-line global-require
    const { OutboxEvent } = require('../src/models');
    const eventos = await OutboxEvent.findAll({ where: { aggregateId: financingCaseId, eventType: 'integration.correspondent.failed' }, transaction });
    assert.equal(eventos.length, 1, 'a proposta recusada também emite integration.correspondent.failed');
  });
});

test('CORRESPONDENT-WEBHOOK-CANCELADO-01: cancelamento enviado pelo provider leva o caso a Cancelado', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();
  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'CANCELLED' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);
  const res = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(res.normalizedStatus, 'CANCELED');
  await withTenantTransaction(tenant, async (transaction) => {
    const caso = await FinancingCase.findByPk(financingCaseId, { transaction });
    assert.equal(caso.status, 'CANCELED');
    assert.match(caso.canceledReason, /Cancelado pelo provider "sandbox" \(status original "CANCELLED"\)/);
    assert.ok(caso.canceledAt);
  });
});
