'use strict';

// F06 — conferência Nayara de 18/10/2026: "Vincular os testes adversariais e seus resultados
// aos requisitos; complementar o que não estiver coberto, especialmente recuperação após
// falha/resposta incerta e replay sem duplicidade." Mapa completo em
// docs/evidencias/seguranca/MAPA_SEGURANCA_FLUXO.md.
//
// Este arquivo complementa o que os testes adversariais existentes não cobriam:
//   - recuperação do fluxo bancário depois de falha definitiva e de resposta incerta;
//   - ataques de fluxo: pular aprovação, reaproveitar aprovação de outro lançamento;
//   - IDOR e RBAC pelas rotas HTTP reais (exportação de dossiê, relatório de vistoria,
//     download de arquivo, leitura de lançamento).
//
// Nenhum cenário está marcado como `todo`: as lacunas PAY-04/05/06 e RBAC-02 encontradas na
// rodada foram corrigidas e os testes passaram a exigir o comportamento correto.
//
// IDOR com empresas REAIS (revisão independente de 18/10): a versão anterior lia
// core.companies sem contexto de tenant — o RLS devolvia 0 linhas e o teste caía num UUID de
// fallback, ou seja, "outra empresa" era uma empresa inexistente. Agora o before() cria (ou
// reaproveita, por nome) duas empresas de verdade com dados próprios:
//   - empresa B no MESMO grupo do tenant A;
//   - empresa C num OUTRO grupo;
// e cada IDOR tem controle positivo: B e C acessam os PRÓPRIOS registros pela mesma rota (200).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.F06_HTTP_TEST_PORT || '21612';

require('../app');
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
const { BankAccount, User, FinancialEntry, EvidencePackageAccessLog, Group, Company } = require('../src/models');

let tenant;
// Empresas REAIS usadas como atacante nos testes de IDOR (ver cabeçalho do arquivo).
let sameGroupTenant; // empresa B, mesmo grupo de A
let otherGroupTenant; // empresa C, outro grupo
let baseUrl;
// fixtures[companyId] = { fileId, inspectionId, evidencePackageId, entryId } de cada empresa.
const fixtures = {};

function tokenFor(ctx, permissions) {
  return signAccessToken({
    sub: tenant.userId,
    group_id: ctx.groupId,
    company_id: ctx.companyId,
    roles: ['f06'],
    permissions,
  });
}

async function http(path, ctx, permissions) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokenFor(ctx, permissions)}` } });
  return res.status;
}

// Cria (ou reaproveita pelo nome, para não multiplicar empresas no banco de dev) uma empresa
// real. core.companies é filtrada por grupo — a criação acontece no contexto do próprio grupo.
async function realCompany(groupId, name) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    const [company] = await Company.findOrCreate({ where: { groupId, name }, defaults: { groupId, name }, transaction });
    return company;
  });
}

// Mesmo conjunto de registros para cada empresa: arquivo, vistoria com relatório, dossiê e
// lançamento. Fixtures COMMITADAS — as requisições HTTP rodam em transações próprias e não
// enxergariam dados de uma transação de teste com rollback. Tudo marcado "F06".
async function seedCompanyFixtures(ctx) {
  return withTenantTransaction(ctx, async (t) => {
    const suffix = uniqueSuffix();
    const file = await filesService.uploadFile(
      { groupId: ctx.groupId, companyId: ctx.companyId, fileName: `f06-contrato-${suffix}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 F06 ${suffix}`).toString('base64'), category: 'contracts' },
      tenant.userId,
      t
    );
    const property = await propertiesService.createProperty(
      { groupId: ctx.groupId, companyId: ctx.companyId, title: `F06 Imovel ${suffix}`, internalCode: `F06-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      t
    );
    const contract = await contractsService.createContract(
      { groupId: ctx.groupId, companyId: ctx.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      t
    );
    const inspection = await inspectionsService.createInspection(
      { groupId: ctx.groupId, companyId: ctx.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      t
    );
    const item = await inspectionsService.addInspectionItem(inspection.id, { itemName: 'F06 Piso', condition: 'GOOD' }, tenant.userId, t);
    await inspectionsService.attachInspectionItemMedia(item.id, { fileId: file.id, mediaType: 'PHOTO' }, tenant.userId, t);
    await inspectionsService.completeInspection(inspection.id, tenant.userId, t);
    await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, t);

    const legalCase = await legalCasesService.createLegalCase(
      { groupId: ctx.groupId, companyId: ctx.companyId, contractId: contract.id, caseType: 'LITIGATION', summary: `F06 dossie ${suffix}` },
      tenant.userId,
      t
    );
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, t);

    const costCenter = await createTestCostCenter(ctx, t);
    const entry = await createFinancialEntry(
      { groupId: ctx.groupId, companyId: ctx.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 77.7, description: `F06 lançamento ${suffix}`, dueAt: new Date(Date.now() + 86400000), costCenterId: costCenter.id },
      tenant.userId,
      t
    );
    return { fileId: file.id, inspectionId: inspection.id, evidencePackageId: pkg.id, entryId: entry.id };
  });
}

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;

  const companyB = await realCompany(tenant.groupId, 'HOMO QA — F06 Empresa B (IDOR, mesmo grupo)');
  const [groupC] = await Group.findOrCreate({ where: { name: 'HOMO QA — F06 Grupo C (IDOR)' }, defaults: { name: 'HOMO QA — F06 Grupo C (IDOR)' } });
  const companyC = await realCompany(groupC.id, 'HOMO QA — F06 Empresa C (IDOR, outro grupo)');
  sameGroupTenant = { groupId: tenant.groupId, companyId: companyB.id, userId: tenant.userId };
  otherGroupTenant = { groupId: groupC.id, companyId: companyC.id, userId: tenant.userId };
  assert.notEqual(companyB.id, tenant.companyId, 'empresa B precisa ser diferente de A');
  assert.notEqual(groupC.id, tenant.groupId, 'grupo C precisa ser diferente do grupo de A');

  fixtures[tenant.companyId] = await seedCompanyFixtures(tenant);
  fixtures[companyB.id] = await seedCompanyFixtures(sameGroupTenant);
  fixtures[companyC.id] = await seedCompanyFixtures(otherGroupTenant);

  // As empresas existem de verdade no banco (consulta no contexto do próprio grupo, não a
  // leitura sem contexto que devolvia 0 linhas na versão anterior).
  for (const ctx of [sameGroupTenant, otherGroupTenant]) {
    const found = await withTenantTransaction(ctx, (t) => Company.count({ where: { id: ctx.companyId }, transaction: t }));
    assert.equal(found, 1, `empresa ${ctx.companyId} existe no banco`);
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
});

const A = () => fixtures[tenant.companyId];

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

// Cada atacante (B: mesmo grupo; C: outro grupo) tenta o registro de A (404) e, como controle
// positivo, lê o PRÓPRIO registro equivalente pela mesma rota (200) — prova de que o 404 vem do
// isolamento e não de a rota estar quebrada para aquela empresa.
const attackers = () => [
  ['empresa B (mesmo grupo)', sameGroupTenant],
  ['empresa C (outro grupo)', otherGroupTenant],
];

test('F06-IDOR-01 outra empresa real com legal:read não exporta o dossiê de A pela rota (404) e não deixa rastro na cadeia de custódia', async () => {
  for (const [label, attacker] of attackers()) {
    const own = fixtures[attacker.companyId];
    assert.equal(await http(`/legal/evidence-packages/${A().evidencePackageId}/export`, attacker, ['legal:read']), 404, `${label} → dossiê de A`);
    assert.equal(await http(`/legal/evidence-packages/${own.evidencePackageId}/export`, attacker, ['legal:read']), 200, `controle positivo: ${label} exporta o próprio dossiê`);
  }
  assert.equal(await http(`/legal/evidence-packages/${A().evidencePackageId}/export`, tenant, ['legal:read']), 200, 'controle positivo: A exporta o próprio dossiê');
  const exported = await withTenantTransaction(tenant, (t) =>
    EvidencePackageAccessLog.count({ where: { evidencePackageId: A().evidencePackageId, action: 'EXPORTED' }, transaction: t })
  );
  assert.equal(exported, 1, 'o pacote é novo: só o export permitido de A gerou registro EXPORTED');
});

test('F06-IDOR-02 outra empresa real não lê o relatório de vistoria de A pela rota (404)', async () => {
  for (const [label, attacker] of attackers()) {
    assert.equal(await http(`/legal/inspections/${A().inspectionId}/report`, attacker, ['legal:read']), 404, `${label} → vistoria de A`);
    assert.equal(await http(`/legal/inspections/${fixtures[attacker.companyId].inspectionId}/report`, attacker, ['legal:read']), 200, `controle positivo: ${label}`);
  }
  assert.equal(await http(`/legal/inspections/${A().inspectionId}/report`, tenant, ['legal:read']), 200, 'controle positivo: A');
});

test('F06-IDOR-03 outra empresa real não baixa arquivo de A pela rota de conteúdo (404)', async () => {
  for (const [label, attacker] of attackers()) {
    assert.equal(await http(`/files/${A().fileId}/content`, attacker, ['legal:read']), 404, `${label} → arquivo de A`);
    assert.equal(await http(`/files/${fixtures[attacker.companyId].fileId}/content`, attacker, ['legal:read']), 200, `controle positivo: ${label}`);
  }
});

test('F06-IDOR-04 outra empresa real com finance:read não lê lançamento de A pela rota (404)', async () => {
  for (const [label, attacker] of attackers()) {
    assert.equal(await http(`/finance/entries/${A().entryId}`, attacker, ['finance:read']), 404, `${label} → lançamento de A`);
    assert.equal(await http(`/finance/entries/${fixtures[attacker.companyId].entryId}`, attacker, ['finance:read']), 200, `controle positivo: ${label}`);
  }
  assert.equal(await http(`/finance/entries/${A().entryId}`, tenant, ['finance:read']), 200, 'controle positivo: A');
});

test('F06-RBAC-01 perfil da própria empresa SEM a permissão de leitura é barrado (403) no dossiê, no relatório de vistoria e no lançamento', async () => {
  assert.equal(await http(`/legal/evidence-packages/${A().evidencePackageId}/export`, tenant, ['finance:read']), 403);
  assert.equal(await http(`/legal/inspections/${A().inspectionId}/report`, tenant, ['finance:read']), 403);
  assert.equal(await http(`/finance/entries/${A().entryId}`, tenant, ['legal:read']), 403);
});

// RBAC-02 (corrigido 18/10): leitura de arquivo exige a permissão de leitura de um módulo dono
// do arquivo, ou ser quem fez o upload (src/features/files/fileAccess.service.js). As fixtures
// acima foram enviadas por tenant.userId — por isso estes testes usam um SEGUNDO usuário, senão
// passariam pela regra do uploader e não pela de permissão.
async function rbac02OtherUserId() {
  const [user] = await User.findOrCreate({
    where: { email: 'homo-qa-f06-rbac02@nayaraone.dev' },
    defaults: { name: 'HOMO QA — F06 RBAC-02', passwordHash: 'x', status: 'ACTIVE' },
  });
  return user.id;
}

async function rbac02Http(path, { userId, ctx = tenant, permissions = [], roles = ['f06'] }) {
  const token = signAccessToken({ sub: userId, group_id: ctx.groupId, company_id: ctx.companyId, roles, permissions });
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
}

async function rbac02UploadCommitted(category) {
  return withTenantTransaction(tenant, (t) =>
    filesService.uploadFile(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `f06-rbac02-${category}-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 RBAC02 ${category}`).toString('base64'), category },
      tenant.userId,
      t
    )
  );
}

test('F06-RBAC-02 download de arquivo exige permissão de leitura do módulo dono do arquivo', async () => {
  const otherUserId = await rbac02OtherUserId();
  const path = `/files/${A().fileId}/content`;
  // Arquivo de contrato/foto de vistoria (módulo Jurídico).
  assert.equal(await rbac02Http(path, { userId: otherUserId, permissions: [] }), 403, 'sem permissão nenhuma');
  assert.equal(await rbac02Http(path, { userId: otherUserId, permissions: ['finance:read', 'inventory:read'] }), 403, 'leitura de OUTRO módulo não basta');
  assert.equal(await rbac02Http(`/files/${A().fileId}`, { userId: otherUserId, permissions: ['inventory:read'] }), 403, 'o metadado também é protegido');
  assert.equal(await rbac02Http(path, { userId: otherUserId, permissions: ['legal:read'] }), 200, 'com legal:read baixa');
  // Regra I3 (revisão independente RBAC-02, 9acd0c1): arquivo COM dono — ter feito o upload não
  // basta; é preciso a leitura do módulo dono.
  assert.equal(await rbac02Http(path, { userId: tenant.userId, permissions: [] }), 403, 'uploader sem leitura do módulo dono não baixa arquivo com dono');
  assert.equal(await rbac02Http(path, { userId: tenant.userId, permissions: ['legal:read'] }), 200, 'uploader com legal:read baixa');
  assert.equal(await rbac02Http(path, { userId: otherUserId, ctx: sameGroupTenant, permissions: ['legal:read'] }), 404, 'empresa B real (mesmo grupo) continua 404');
  assert.equal(await rbac02Http(path, { userId: otherUserId, ctx: otherGroupTenant, permissions: ['legal:read'] }), 404, 'empresa C real (outro grupo) continua 404');
});

test('F06-RBAC-02b arquivo do Estoque exige inventory:read; arquivo sem módulo dono só para uploader ou admin', async () => {
  const otherUserId = await rbac02OtherUserId();

  const invoice = await rbac02UploadCommitted('inventory-invoices');
  assert.equal(await rbac02Http(`/files/${invoice.id}/content`, { userId: otherUserId, permissions: ['legal:read'] }), 403);
  assert.equal(await rbac02Http(`/files/${invoice.id}/content`, { userId: otherUserId, permissions: ['inventory:read'] }), 200);

  const orphan = await rbac02UploadCommitted('generic');
  assert.equal(await rbac02Http(`/files/${orphan.id}/content`, { userId: otherUserId, permissions: ['legal:read', 'finance:read', 'inventory:read'] }), 403, 'sem módulo dono: leitura de módulo nenhum basta');
  // Revisão RBAC-02 (9acd0c1): admin é a role de SISTEMA ADMIN (membership), nunca o nome no JWT —
  // o caso positivo do admin real está em files.accessControl.test.js.
  assert.equal(await rbac02Http(`/files/${orphan.id}/content`, { userId: otherUserId, permissions: [], roles: ['admin'] }), 403, 'role "admin" só no token não é admin');
  assert.equal(await rbac02Http(`/files/${orphan.id}/content`, { userId: tenant.userId, permissions: [] }), 200, 'uploader baixa');
});
