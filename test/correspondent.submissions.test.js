'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../src/features/correspondent/cases/simulations.service');
const documentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../src/features/correspondent/cases/submissions.service');
const { withTimeout, SubmitTimeoutError } = submissionsService;
const { Person, File } = require('../src/models');
const { SandboxFinancingProviderAdapter } = require('../src/features/correspondent/adapters/FinancingProviderAdapter');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, providerCode = 'sandbox') {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Submit ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, providerCode, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
    tenant.userId,
    transaction
  );
}

// Checklist completo = sem nenhum requirement obrigatório pendente. Pra cada teste que precisa
// submeter com sucesso, cria 1 requirement obrigatório e já envia o documento (status SUBMITTED).
async function completeChecklist(financingCaseId, transaction) {
  const requirement = await documentsService.createRequirement(
    financingCaseId,
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
    financingCaseId,
    requirement.id,
    { fileId: file.id },
    tenant.userId,
    { groupId: tenant.groupId, companyId: tenant.companyId },
    transaction
  );
}

test('CORRESPONDENT-SUB-01: submete com sucesso (sandbox) quando checklist completo e elegível', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 200000, termMonths: 360 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const submission = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    assert.equal(submission.status, 'SUBMITTED');
    assert.ok(submission.externalCaseId);
    assert.ok(submission.idempotencyKey.startsWith(`financing:${financingCase.id}:provider:sandbox:v`));

    await financingCase.reload({ transaction });
    assert.equal(financingCase.status, 'SUBMITTED');
  });
});

test('CORRESPONDENT-SUB-02: bloqueia submissão com checklist incompleto, nunca chama o adapter', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await documentsService.createRequirement(
      financingCase.id,
      { documentType: 'COMPROVANTE_RENDA', required: true },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    await assert.rejects(
      () => submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'SUBMISSION_CHECKLIST_INCOMPLETE'
    );
  });
});

test('CORRESPONDENT-SUB-03: bloqueia submissão de case inelegível (valor acima do teto do provider)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);

    await assert.rejects(
      () => submissionsService.submitFinancingCase(financingCase.id, { amount: 99999999 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT'
    );
  });
});

test('CORRESPONDENT-SUB-04: idempotência — 2 submissões com a mesma key retornam a MESMA linha, adapter chamado uma única vez', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    let callCount = 0;
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async function patched(req) {
      callCount += 1;
      return original.call(this, req);
    };
    try {
      const first = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);
      const second = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);
      assert.equal(first.id, second.id, 'segunda chamada com a mesma key deve devolver a submission já existente, nunca criar outra');
      assert.equal(callCount, 1, 'o adapter nunca pode ser chamado de novo pra uma key já existente');
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
  });
});

test('CORRESPONDENT-SUB-05: adapter que lança erro (não-timeout) vira status UNKNOWN, nunca derruba a requisição com 500 cru', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 150000, termMonths: 240 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => {
      throw new Error('Falha simulada de rede do provider.');
    };
    try {
      const submission = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);
      assert.equal(submission.status, 'UNKNOWN');
      assert.ok(submission.failureReason.includes('Falha simulada'));

      await financingCase.reload({ transaction });
      assert.notEqual(financingCase.status, 'SUBMITTED', 'case não pode virar SUBMITTED quando a submissão falhou');
    } finally {
      SandboxFinancingProviderAdapter.prototype.submitCase = original;
    }
  });
});

test('CORRESPONDENT-SUB-05b: withTimeout rejeita com SubmitTimeoutError quando a promise demora mais que o limite', async () => {
  const neverResolves = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverResolves, 20), (err) => err instanceof SubmitTimeoutError);
});

test('CORRESPONDENT-SUB-05c: withTimeout resolve normalmente quando a promise termina antes do limite', async () => {
  const fast = Promise.resolve('ok');
  const result = await withTimeout(fast, 1000);
  assert.equal(result, 'ok');
});

test('CORRESPONDENT-SUB-06: financing_case inexistente — NOT_FOUND', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        submissionsService.submitFinancingCase(
          '00000000-0000-0000-0000-000000000000',
          {},
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      (err) => err.code === 'FINANCING_CASE_NOT_FOUND'
    );
  });
});

test('CORRESPONDENT-SUB-07: acknowledgeUnknownSubmission exige status UNKNOWN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const submission = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(submission.status, 'SUBMITTED');

    await assert.rejects(
      () => submissionsService.acknowledgeUnknownSubmission(submission.id, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'SUBMISSION_NOT_UNKNOWN'
    );
  });
});

test('CORRESPONDENT-SUB-08: listSubmissions retorna mais recente primeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 50000, termMonths: 60 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const first = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const list = await submissionsService.listSubmissions(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, first.id);
  });
});

// RLS cross-company — mesmo padrão adversarial já usado nos testes anteriores do módulo.
test('CORRESPONDENT-SUB-09: outra empresa não enxerga submission via SELECT direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const submission = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [rows] = await sequelize.query('SELECT id FROM "correspondent"."provider_submissions" WHERE id = :id', {
      replacements: { id: submission.id },
      transaction,
    });
    assert.equal(rows.length, 0, 'empresa diferente não deve conseguir SELECT na submission da empresa original');
  });
});

test('CORRESPONDENT-SUB-10: evento financing.submission_requested é emitido (outbox)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await completeChecklist(financingCase.id, transaction);
    await simulationsService.createSimulation(financingCase.id, { amount: 100000, termMonths: 120 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const submission = await submissionsService.submitFinancingCase(financingCase.id, {}, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const [rows] = await sequelize.query(
      `SELECT event_type FROM integration.outbox_events WHERE event_type = 'financing.submission_requested' AND idempotency_key = :key`,
      { replacements: { key: `financing.submission_requested:${submission.idempotencyKey}` }, transaction }
    );
    assert.equal(rows.length, 1);
  });
});
