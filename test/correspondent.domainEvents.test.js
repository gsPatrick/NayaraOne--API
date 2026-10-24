'use strict';

// Marco 8, Fase 9 — Eventos de domínio (CRM/Financeiro). Confirma que cada evento mínimo do
// Caderno é emitido no momento certo (lendo a tabela de outbox depois da ação), que nenhum
// payload carrega conteúdo de documento restrito, e que a atualização da oportunidade do CRM
// acontece via audit log (nunca escrita direta no registro da Opportunity).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../src/features/correspondent/cases/submissions.service');
const webhooksService = require('../src/features/correspondent/webhooks.service');
const settingsService = require('../src/features/settings/settings.service');
const { Person, File, OutboxEvent, AuditLog, Opportunity, FinancingCase } = require('../src/models');

let tenant;
const createdFinancingCaseIds = [];
const createdOpportunityIds = [];

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  if (createdFinancingCaseIds.length > 0) {
    await sequelize.query('DELETE FROM correspondent.external_case_routing WHERE financing_case_id = ANY(ARRAY[:ids]::uuid[])', {
      replacements: { ids: createdFinancingCaseIds },
    });
    await FinancingCase.destroy({ where: { id: createdFinancingCaseIds } });
  }
  if (createdOpportunityIds.length > 0) {
    await Opportunity.destroy({ where: { id: createdOpportunityIds }, force: true });
  }
  await sequelize.close();
});

async function makeCase(transaction, extra = {}) {
  const principal = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente Evt ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }], ...extra },
    tenant.userId,
    transaction
  );
}

async function makeFile(transaction, name) {
  return File.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName: name, mimeType: 'application/pdf', storageKey: `test/${Date.now()}-${name}`, sizeBytes: 10 },
    { transaction }
  );
}

async function findEvent(eventType, aggregateId, transaction) {
  return OutboxEvent.findOne({ where: { eventType, aggregateId }, transaction });
}

test('CORRESPONDENT-EVT-01: criar um caso emite financing.case.created', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const event = await findEvent('financing.case.created', financingCase.id, transaction);
    assert.ok(event, 'evento financing.case.created não foi emitido');
    assert.equal(event.payloadJson.id, financingCase.id);
  });
});

test('CORRESPONDENT-EVT-02: completar o checklist de documentos emite financing.documents.completed exatamente uma vez', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const actorContext = { groupId: tenant.groupId, companyId: tenant.companyId };

    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'RG_CPF' }, tenant.userId, actorContext, transaction);
    let event = await findEvent('financing.documents.completed', financingCase.id, transaction);
    assert.equal(event, null, 'não deveria emitir antes do checklist estar completo');

    const file = await makeFile(transaction, 'rg.pdf');
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, actorContext, transaction);
    event = await findEvent('financing.documents.completed', financingCase.id, transaction);
    assert.equal(event, null, 'envio sem validação humana ainda não completa o checklist');

    await caseDocumentsService.validateRequirement(financingCase.id, requirement.id, tenant.userId, actorContext, transaction);
    event = await findEvent('financing.documents.completed', financingCase.id, transaction);
    assert.ok(event, 'evento financing.documents.completed não foi emitido após a validação humana');

    // Documento substituído (nova versão) não deve tentar duplicar o evento (idempotencyKey fixa
    // por case faria o 2º INSERT colidir se não houvesse o check-before-insert).
    const file2 = await makeFile(transaction, 'rg-v2.pdf');
    await assert.doesNotReject(() =>
      caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file2.id }, tenant.userId, actorContext, transaction)
    );
    const countAfter = await OutboxEvent.count({ where: { eventType: 'financing.documents.completed', aggregateId: financingCase.id }, transaction });
    assert.equal(countAfter, 1, 'financing.documents.completed nunca deve duplicar pelo mesmo case');
  });
});

test('CORRESPONDENT-EVT-03: payload de financing.documents.completed nunca inclui conteúdo/fileId do documento restrito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const actorContext = { groupId: tenant.groupId, companyId: tenant.companyId };
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'RG_CPF' }, tenant.userId, actorContext, transaction);
    const file = await makeFile(transaction, 'rg.pdf');
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, actorContext, transaction);
    await caseDocumentsService.validateRequirement(financingCase.id, requirement.id, tenant.userId, actorContext, transaction);

    const event = await findEvent('financing.documents.completed', financingCase.id, transaction);
    const payloadStr = JSON.stringify(event.payloadJson);
    assert.ok(!payloadStr.includes(file.id), 'payload do evento vazou o fileId de um documento RESTRICTED');
    assert.ok(!payloadStr.includes('rg.pdf'), 'payload do evento vazou o nome do arquivo de um documento RESTRICTED');
  });
});

test('CORRESPONDENT-EVT-04: submissão com sucesso emite financing.submitted', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await makeCase(transaction);
    const actorContext = { groupId: tenant.groupId, companyId: tenant.companyId };
    const requirement = await caseDocumentsService.createRequirement(financingCase.id, { documentType: 'RG_CPF' }, tenant.userId, actorContext, transaction);
    const file = await makeFile(transaction, 'rg.pdf');
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, actorContext, transaction);
    await caseDocumentsService.validateRequirement(financingCase.id, requirement.id, tenant.userId, actorContext, transaction);

    const submission = await submissionsService.submitFinancingCase(
      financingCase.id,
      { consent: true, amount: 200000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(submission.status, 'SUBMITTED', 'pré-condição do teste: submissão precisa ter sucedido');

    const event = await findEvent('financing.submitted', financingCase.id, transaction);
    assert.ok(event, 'evento financing.submitted não foi emitido após submissão bem-sucedida');
    assert.equal(event.payloadJson.externalCaseId, submission.externalCaseId);
  });
});

// A partir daqui: testes de WEBHOOK usam `withTenantTransaction` (commit real), igual
// test/correspondent.webhooks.test.js — `processFinancingWebhook` abre sua PRÓPRIA transação.

function signedWebhookRequest(secret, body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, headers: { 'x-webhook-signature': `sha256=${signature}` } };
}

async function setWebhookSecret(secret) {
  await withTenantTransaction(tenant, (t) =>
    settingsService.upsertSetting('correspondent.sandbox_webhook_secret', secret, tenant, tenant.userId, t)
  );
}

async function createSubmittedCase(extra = {}) {
  let financingCaseId;
  await withTenantTransaction(tenant, async (transaction) => {
    const principal = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente Evt Webhook ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }], ...extra },
      tenant.userId,
      transaction
    );
    financingCaseId = financingCase.id;

    const requirement = await caseDocumentsService.createRequirement(
      financingCase.id,
      { documentType: 'RG_CPF', required: true },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    const file = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId },
      { transaction }
    );
    await caseDocumentsService.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    await caseDocumentsService.validateRequirement(financingCase.id, requirement.id, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
  });

  const submission = await withTenantTransaction(tenant, (transaction) =>
    submissionsService.submitFinancingCase(financingCaseId, { consent: true, amount: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction)
  );
  assert.equal(submission.status, 'SUBMITTED', 'pré-condição do teste: submissão precisa ter sucedido');

  createdFinancingCaseIds.push(financingCaseId);
  return { financingCaseId, externalCaseId: submission.externalCaseId };
}

test('CORRESPONDENT-EVT-05: webhook aplicando APPROVED emite financing.status.changed e financing.approved', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);
  const result = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(result.applied, true, 'pré-condição do teste: a transição precisa ter sido aplicada');

  const statusEvents = await withTenantTransaction(tenant, (t) => OutboxEvent.findAll({ where: { eventType: 'financing.status.changed', aggregateId: financingCaseId }, transaction: t }));
  const statusChanged = statusEvents.find((event) => event.payloadJson.status === 'APPROVED');
  assert.ok(statusChanged, 'evento financing.status.changed da aprovação não foi emitido');
  assert.equal(statusChanged.payloadJson.status, 'APPROVED');

  const approved = await withTenantTransaction(tenant, (t) => OutboxEvent.findOne({ where: { eventType: 'financing.approved', aggregateId: financingCaseId }, transaction: t }));
  assert.ok(approved, 'evento terminal financing.approved não foi emitido quando o status virou APPROVED');
});

test('CORRESPONDENT-EVT-06: webhook fora de ordem (ignorado) NÃO emite financing.status.changed', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  // Primeiro aplica APPROVED (rank alto)...
  const body1 = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' };
  const signed1 = signedWebhookRequest(secret, body1);
  await webhooksService.processFinancingWebhook('sandbox', signed1.rawBody, signed1.headers, body1);

  const countBefore = await withTenantTransaction(tenant, (t) => OutboxEvent.count({ where: { eventType: 'financing.status.changed', aggregateId: financingCaseId }, transaction: t }));

  // ...depois um evento atrasado de ANALYSIS (rank baixo) chega — não deve regredir nem emitir.
  const body2 = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const signed2 = signedWebhookRequest(secret, body2);
  const result2 = await webhooksService.processFinancingWebhook('sandbox', signed2.rawBody, signed2.headers, body2);
  assert.equal(result2.applied, false, 'pré-condição do teste: a 2ª transição não deveria ser aplicada (fora de ordem)');

  const countAfter = await withTenantTransaction(tenant, (t) => OutboxEvent.count({ where: { eventType: 'financing.status.changed', aggregateId: financingCaseId }, transaction: t }));
  assert.equal(countAfter, countBefore, 'webhook fora de ordem (não aplicado) não deveria emitir financing.status.changed de novo');
});

test('CORRESPONDENT-EVT-07: status aplicado com opportunityId vinculado atualiza a oportunidade via audit log, nunca escrita direta', async () => {
  const person = await withTenantTransaction(tenant, (t) =>
    Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Evt ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    )
  );
  const opportunity = await withTenantTransaction(tenant, (t) =>
    Opportunity.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'NEGOTIATION', createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    )
  );
  createdOpportunityIds.push(opportunity.id);

  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { externalCaseId } = await createSubmittedCase({ opportunityId: opportunity.id });

  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);
  const result = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(result.applied, true, 'pré-condição do teste: a transição precisa ter sido aplicada');

  const auditEntry = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityType: 'Opportunity', entityId: opportunity.id, action: 'crm.opportunity.financing_status_changed' }, transaction: t }));
  assert.ok(auditEntry, 'audit log de atualização da oportunidade não foi criado');

  const reloaded = await withTenantTransaction(tenant, (t) => Opportunity.findOne({ where: { id: opportunity.id }, transaction: t }));
  assert.equal(reloaded.stage, 'NEGOTIATION', 'o módulo de financiamento nunca deve escrever direto no stage da oportunidade');
});

test('CORRESPONDENT-EVT-08: case sem opportunityId não quebra e não gera audit log de oportunidade', async () => {
  const secret = `wh-secret-${uniqueSuffix()}`;
  await setWebhookSecret(secret);
  const { financingCaseId, externalCaseId } = await createSubmittedCase();

  const body = { externalCaseId, externalEventId: `evt-${uniqueSuffix()}`, status: 'APPROVED' };
  const { rawBody, headers } = signedWebhookRequest(secret, body);
  const result = await webhooksService.processFinancingWebhook('sandbox', rawBody, headers, body);
  assert.equal(result.applied, true);

  const auditEntry = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityType: 'Opportunity', entityId: financingCaseId }, transaction: t }));
  assert.equal(auditEntry, null, 'não deveria existir audit log de Opportunity para um case sem opportunityId vinculado');
});
