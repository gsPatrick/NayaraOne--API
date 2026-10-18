'use strict';

// F06 — conferência Nayara de 18/10/2026: "Vincular os testes adversariais e seus resultados
// aos requisitos; complementar o que não estiver coberto, especialmente recuperação após
// falha/resposta incerta e replay sem duplicidade." Mapa completo em
// Maturacao/SEGURANCA_FLUXO_MARCOS4_5.md.
//
// Este arquivo complementa o que os testes adversariais existentes não cobriam:
//   - recuperação do fluxo bancário depois de falha definitiva e de resposta incerta;
//   - ataques de fluxo: pular aprovação, reaproveitar aprovação de outro lançamento;
//   - IDOR e RBAC pelas rotas HTTP reais (exportação de dossiê, relatório de vistoria,
//     download de arquivo, leitura de lançamento).
//
// Os cenários marcados com `todo` documentam LACUNAS REAIS encontradas nesta rodada: o teste
// roda e mostra o comportamento atual, mas não derruba a suíte até a correção entrar (ver o
// texto do todo e o mapa). Quando a correção entrar, basta remover o `todo`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.F06_HTTP_TEST_PORT || '21612';

const app = require('../app');
const {
  sequelize,
  getSeedTenant,
  withTenantTransaction,
  withRollbackTenantTransaction,
  createTestCostCenter,
  uniqueSuffix,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { createFinancialEntry } = require('../src/features/finance/financialEntries.service');
const { createPaymentIntent, approvePaymentIntent } = require('../src/features/finance/paymentIntents.service');
const { submitPaymentIntentToBank, confirmBankPayment } = require('../src/features/finance/bankPayments.service');
const approvalsService = require('../src/features/finance/approvals.service');
const filesService = require('../src/features/files/files.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const { BankAccount, User, FinancialEntry, EvidencePackageAccessLog } = require('../src/models');

let tenant;
let otherCompanyId;
let baseUrl;
const fixtures = {};

function tokenFor(companyId, permissions) {
  return signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: companyId,
    roles: ['f06'],
    permissions,
  });
}

async function http(path, companyId, permissions) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokenFor(companyId, permissions)}` } });
  return res.status;
}

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;

  // Fixtures COMMITADAS do tenant A — as requisições HTTP rodam em transações próprias, então
  // não enxergariam dados de uma transação de teste com rollback. Tudo marcado "F06".
  await withTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const file = await filesService.uploadFile(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `f06-contrato-${suffix}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 F06 ${suffix}`).toString('base64'), category: 'contracts' },
      tenant.userId,
      t
    );
    fixtures.fileId = file.id;

    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `F06 Imovel ${suffix}`, internalCode: `F06-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      t
    );
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      t
    );
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      t
    );
    const item = await inspectionsService.addInspectionItem(inspection.id, { itemName: 'F06 Piso', condition: 'GOOD' }, tenant.userId, t);
    await inspectionsService.attachInspectionItemMedia(item.id, { fileId: file.id, mediaType: 'PHOTO' }, tenant.userId, t);
    await inspectionsService.completeInspection(inspection.id, tenant.userId, t);
    await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, t);
    fixtures.inspectionId = inspection.id;

    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, caseType: 'LITIGATION', summary: `F06 dossie ${suffix}` },
      tenant.userId,
      t
    );
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, t);
    fixtures.evidencePackageId = pkg.id;

    const costCenter = await createTestCostCenter(tenant, t);
    const entry = await createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 77.7, description: `F06 lançamento ${suffix}`, dueAt: new Date(Date.now() + 86400000), costCenterId: costCenter.id },
      tenant.userId,
      t
    );
    fixtures.entryId = entry.id;
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  // Mesmo padrão dos demais testes que sobem ../app (app.listen incondicional).
  process.exit(0);
});

// ---------------------------------------------------------------------------------------------
// Fluxo de pagamento bancário — ataques de fluxo e recuperação
// ---------------------------------------------------------------------------------------------

async function makeApprover(transaction) {
  const [approver] = await User.findOrCreate({
    where: { email: `homo-qa-f06-approver-${uniqueSuffix()}@nayaraone.dev` },
    defaults: { name: 'HOMO QA — Aprovador F06', passwordHash: 'x', status: 'ACTIVE' },
    transaction,
  });
  return approver.id;
}

async function makePayable(transaction) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  const bankAccount = await BankAccount.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `F06-${uniqueSuffix()}`, pixKey: `f06-${uniqueSuffix()}@nayaraone.dev`, status: 'ACTIVE' },
    { transaction }
  );
  return createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 210.4, description: `F06 pagamento ${uniqueSuffix()}`, dueAt: new Date(Date.now() + 86400000), costCenterId: costCenter.id, bankAccountId: bankAccount.id },
    tenant.userId,
    transaction
  );
}

async function approvedIntentFor(entryId, transaction) {
  const intent = await createPaymentIntent({ financialEntryId: entryId }, tenant.userId, transaction);
  return approvePaymentIntent(intent.id, await makeApprover(transaction), transaction);
}

test('F06-PAY-01 pular a aprovação: submeter ao banco uma intenção ainda PENDING é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await makePayable(t);
    const intent = await createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await assert.rejects(
      () => submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t),
      (err) => err.code === 'FINANCE_PAYMENT_INTENT_NOT_APPROVED'
    );
    await entry.reload({ transaction: t });
    assert.equal(entry.status, 'PENDING');
  });
});

test('F06-PAY-02 reaproveitar a aprovação de OUTRO lançamento numa intenção é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const target = await makePayable(t);
    const other = await makePayable(t);
    const approvalOfOther = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: other.id, riskLevel: 'LOW' },
      tenant.userId,
      t
    );
    await assert.rejects(
      () => createPaymentIntent({ financialEntryId: target.id, approvalRequestId: approvalOfOther.id }, tenant.userId, t),
      (err) => err.code === 'FINANCE_PAYMENT_INTENT_VALIDATION'
    );
  });
});

test('F06-PAY-03 recuperação após falha DEFINITIVA: nova tentativa confirmada liquida uma vez; replays e confirmação tardia da tentativa rejeitada não duplicam', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await makePayable(t);

    const first = await submitPaymentIntentToBank((await approvedIntentFor(entry.id, t)).id, 'PIX', { userId: tenant.userId }, t);
    const failed = await confirmBankPayment(first.externalSubmissionId, 'REJECTED', t);
    assert.equal(failed.status, 'FAILED');
    await entry.reload({ transaction: t });
    assert.equal(entry.status, 'PENDING', 'falha definitiva não liquida');

    const second = await submitPaymentIntentToBank((await approvedIntentFor(entry.id, t)).id, 'PIX', { userId: tenant.userId }, t);
    const executed = await confirmBankPayment(second.externalSubmissionId, 'CONFIRMED', t);
    assert.equal(executed.status, 'EXECUTED');

    await confirmBankPayment(second.externalSubmissionId, 'CONFIRMED', t);
    await confirmBankPayment(first.externalSubmissionId, 'CONFIRMED', t);

    await entry.reload({ transaction: t });
    assert.equal(entry.status, 'SETTLED');
    const settledCount = await FinancialEntry.count({ where: { id: entry.id, status: 'SETTLED' }, transaction: t });
    const children = await FinancialEntry.count({ where: { parentEntryId: entry.id }, transaction: t });
    assert.equal(settledCount, 1, 'o lançamento foi liquidado uma única vez');
    assert.equal(children, 0, 'nenhum lançamento filho/duplicado criado pelos replays');
  });
});

test(
  'F06-PAY-04 enquanto um pagamento está SUBMITTED (em trânsito no banco), abrir outra intenção para o mesmo lançamento é recusado',
  { todo: 'LACUNA REAL (F06, 18/10): createPaymentIntent só considera PENDING/APPROVED como "em aberto" — com a primeira intenção SUBMITTED, uma segunda é aceita e pode ser submetida ao banco: pagamento em dobro. Correção em paymentIntents.service.js (arquivo do F03).' },
  async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await makePayable(t);
      await submitPaymentIntentToBank((await approvedIntentFor(entry.id, t)).id, 'PIX', { userId: tenant.userId }, t);
      await assert.rejects(
        () => createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t),
        (err) => err.code === 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN'
      );
    });
  }
);

test(
  'F06-PAY-05 resposta INCERTA do banco seguida da confirmação real: o pagamento é registrado no ledger exatamente uma vez',
  { todo: 'LACUNA REAL (F06, 18/10): confirmBankPayment trata qualquer status diferente de CONFIRMED como FAILED, inclusive status não finais ("em processamento"). A confirmação real que chega depois é ignorada (a intenção já não está SUBMITTED): o banco pagou e o lançamento fica PENDING. Correção em bankPayments.service.js (arquivo do F03): status não final mantém SUBMITTED.' },
  async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await makePayable(t);
      const submitted = await submitPaymentIntentToBank((await approvedIntentFor(entry.id, t)).id, 'PIX', { userId: tenant.userId }, t);
      const uncertain = await confirmBankPayment(submitted.externalSubmissionId, 'PROCESSING', t);
      assert.notEqual(uncertain.status, 'EXECUTED', 'resposta incerta nunca vira sucesso');
      await confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', t);
      await entry.reload({ transaction: t });
      assert.equal(entry.status, 'SETTLED', 'a confirmação real posterior precisa ser registrada');
    });
  }
);

test(
  'F06-PAY-06 depois de uma resposta INCERTA, não se abre um segundo pagamento para o mesmo lançamento',
  { todo: 'LACUNA REAL (F06, 18/10): a resposta incerta marca a intenção como FAILED e libera uma nova intenção para o mesmo lançamento — se o banco tiver processado a primeira, paga-se duas vezes. Correção em paymentIntents.service.js/bankPayments.service.js (arquivos do F03).' },
  async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await makePayable(t);
      const submitted = await submitPaymentIntentToBank((await approvedIntentFor(entry.id, t)).id, 'PIX', { userId: tenant.userId }, t);
      await confirmBankPayment(submitted.externalSubmissionId, 'PROCESSING', t);
      await assert.rejects(
        () => createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t),
        (err) => err.code === 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN'
      );
    });
  }
);

// ---------------------------------------------------------------------------------------------
// IDOR e RBAC pelas rotas HTTP reais
// ---------------------------------------------------------------------------------------------

test('F06-IDOR-01 outra empresa com legal:read não exporta o dossiê de A pela rota (404) e não deixa rastro na cadeia de custódia', async () => {
  const status = await http(`/legal/evidence-packages/${fixtures.evidencePackageId}/export`, otherCompanyId, ['legal:read']);
  assert.equal(status, 404);
  const own = await http(`/legal/evidence-packages/${fixtures.evidencePackageId}/export`, tenant.companyId, ['legal:read']);
  assert.equal(own, 200, 'controle positivo: a própria empresa exporta');
  const exported = await withTenantTransaction(tenant, (t) =>
    EvidencePackageAccessLog.count({ where: { evidencePackageId: fixtures.evidencePackageId, action: 'EXPORTED' }, transaction: t })
  );
  assert.equal(exported, 1, 'o pacote é novo: só o export permitido gerou registro EXPORTED');
});

test('F06-IDOR-02 outra empresa não lê o relatório de vistoria de A pela rota (404)', async () => {
  assert.equal(await http(`/legal/inspections/${fixtures.inspectionId}/report`, otherCompanyId, ['legal:read']), 404);
  assert.equal(await http(`/legal/inspections/${fixtures.inspectionId}/report`, tenant.companyId, ['legal:read']), 200, 'controle positivo');
});

test('F06-IDOR-03 outra empresa não baixa arquivo de A pela rota de conteúdo (404)', async () => {
  assert.equal(await http(`/files/${fixtures.fileId}/content`, otherCompanyId, []), 404);
});

test('F06-IDOR-04 outra empresa com finance:read não lê lançamento de A pela rota (404)', async () => {
  assert.equal(await http(`/finance/entries/${fixtures.entryId}`, otherCompanyId, ['finance:read']), 404);
  assert.equal(await http(`/finance/entries/${fixtures.entryId}`, tenant.companyId, ['finance:read']), 200, 'controle positivo');
});

test('F06-RBAC-01 perfil da própria empresa SEM a permissão de leitura é barrado (403) no dossiê, no relatório de vistoria e no lançamento', async () => {
  assert.equal(await http(`/legal/evidence-packages/${fixtures.evidencePackageId}/export`, tenant.companyId, ['finance:read']), 403);
  assert.equal(await http(`/legal/inspections/${fixtures.inspectionId}/report`, tenant.companyId, ['finance:read']), 403);
  assert.equal(await http(`/finance/entries/${fixtures.entryId}`, tenant.companyId, ['legal:read']), 403);
});

test(
  'F06-RBAC-02 download de arquivo exige permissão de leitura do módulo dono do arquivo',
  { todo: 'LACUNA REAL (F06, 18/10): GET /files/:id/content só exige autenticação + tenant (files.routes.js não tem requirePermission). Dentro da mesma empresa, um perfil sem legal:read baixa documento de contrato/foto de vistoria. Exige decisão de desenho (permissão por módulo dono do arquivo).' },
  async () => {
    assert.equal(await http(`/files/${fixtures.fileId}/content`, tenant.companyId, []), 403);
  }
);
