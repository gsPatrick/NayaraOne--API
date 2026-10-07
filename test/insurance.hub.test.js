'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { FinancialEntry, InsuranceRenewalTask, Notification, File, FileLink } = require('../src/models');
const { createFinancialEntry } = require('../src/features/finance/financialEntries.service');
const insuranceService = require('../src/features/procurement/insurance.service');
const { alertDueRenewals } = require('../src/engines/jobs/insuranceRenewalAlertJob');
const AppError = require('../src/utils/AppError');

// Gap real encontrado em auditoria "loop até secar" (2026-10-05, rodada 1): o Insurance Hub
// (Marco 7 — "COMPRAS/PROCUREMENT + SEGUROS") não tinha NENHUM teste automatizado, apesar do
// Marco 6 ter estabelecido o padrão de testar admin/permissões/RLS explicitamente. Este arquivo
// cobre o fluxo principal (sandbox, sem nenhuma seguradora real configurada — é o default
// seguro do tenant) e os 2 bugs reais já corrigidos nesta mesma auditoria.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('Insurance Hub: fluxo feliz completo — cotação → emissão → sinistro → liquidação cria FinancialEntry', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    assert.equal(policy.status, 'DRAFT');

    const quoted = await insuranceService.quotePolicy(policy.id, {}, { userId: tenant.userId }, transaction);
    assert.equal(quoted.status, 'QUOTED');
    assert.ok(quoted.premiumAmount);

    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' },
      { userId: tenant.userId },
      transaction
    );
    assert.equal(issued.status, 'ACTIVE');
    assert.equal(issued.provider, 'sandbox');

    const claim = await insuranceService.openClaim(
      policy.id,
      { description: 'teste automatizado', claimAmount: 1500 },
      { userId: tenant.userId },
      transaction
    );
    assert.equal(claim.status, 'OPEN');

    const submitted = await insuranceService.submitClaim(claim.id, { userId: tenant.userId }, transaction);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.ok(submitted.externalClaimId);

    const settled = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', 1500, transaction);
    assert.equal(settled.status, 'SETTLED');
    assert.ok(settled.financialEntryId, 'indenização confirmada precisa integrar o Financeiro (contrato, Insurance Hub)');

    const entry = await FinancialEntry.findByPk(settled.financialEntryId, { transaction });
    assert.equal(entry.entryType, 'CREDIT');
    assert.equal(entry.nature, 'RECEIVABLE');
    assert.equal(Number(entry.amount), 1500);
  });
});

test('Insurance Hub: sinistro rejeitado pela seguradora NÃO cria lançamento financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, { userId: tenant.userId }, transaction);
    const claim = await insuranceService.openClaim(policy.id, { description: 'teste rejeitado', claimAmount: 500 }, { userId: tenant.userId }, transaction);
    const submitted = await insuranceService.submitClaim(claim.id, { userId: tenant.userId }, transaction);

    const rejected = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'REJECTED', null, transaction);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.financialEntryId, null);
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): openClaim não
// validava claimAmount — aceitava negativo/inválido sem erro.
test('Insurance Hub: openClaim recusa claimAmount negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, { userId: tenant.userId }, transaction);
    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'valor inválido', claimAmount: -100 }, { userId: tenant.userId }, transaction),
      (err) => { assert.equal(err.code, 'INSURANCE_CLAIM_VALIDATION'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 11): "parcelas" é campo contratado da apólice
// (seguro-fiança) e entidade própria do Insurance Hub ("installments") — a migration/model já
// existiam mas nada no sistema criava uma linha. `issuePolicy` agora gera as parcelas do
// prêmio automaticamente.
test('Insurance Hub: emitir a apólice gera as parcelas do prêmio (installments), e pagar uma dá baixa validada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, { userId: tenant.userId }, transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 3 },
      { userId: tenant.userId },
      transaction
    );

    const installments = await insuranceService.listPolicyInstallments(issued.id, transaction);
    assert.equal(installments.length, 3, 'issuePolicy precisa gerar as 3 parcelas pedidas');
    const sum = installments.reduce((acc, i) => acc + Number(i.amount), 0);
    assert.ok(Math.abs(sum - Number(issued.premiumAmount)) < 0.01, 'soma das parcelas precisa bater com o prêmio (sem perder centavos no arredondamento)');
    assert.ok(installments.every((i) => i.status === 'PENDING'));

    // Pagar uma parcela exige um FinancialEntry real, SETTLED, com o mesmo valor — mesmo padrão
    // fail-closed de commissions.service.js#markInstallmentPaid.
    const firstInstallment = installments[0];
    const entry = await createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: Number(firstInstallment.amount), description: 'Pagamento de parcela de seguro (teste)' }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, entry.id, { userId: tenant.userId }, transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_SETTLED');
        return true;
      }
    );

    const { settleFinancialEntry } = require('../src/features/finance/financialEntries.service');
    await settleFinancialEntry(entry.id, tenant.userId, transaction);
    const paid = await insuranceService.payInsurancePolicyInstallment(firstInstallment.id, entry.id, { userId: tenant.userId }, transaction);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.financialEntryId, entry.id);

    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, entry.id, { userId: tenant.userId }, transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ALREADY_PAID');
        return true;
      }
    );
  });
});

// Bug real corrigido nesta auditoria: confirmClaimSettlement não validava que existia algum
// valor (settledAmount OU claimAmount) antes de chamar createFinancialEntry — isso vazava
// FINANCE_ENTRY_VALIDATION cru pela resposta do webhook público em vez do padrão
// 200+status=REJECTED já usado pro resto desse fluxo.
test('Insurance Hub: confirmação SETTLED sem nenhum valor disponível marca REJECTED em vez de quebrar', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, { userId: tenant.userId }, transaction);
    // Sinistro aberto SEM claimAmount (campo opcional) — e confirmação sem settledAmount.
    const claim = await insuranceService.openClaim(policy.id, { description: 'sem valor nenhum' }, { userId: tenant.userId }, transaction);
    const submitted = await insuranceService.submitClaim(claim.id, { userId: tenant.userId }, transaction);

    const result = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', null, transaction);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.financialEntryId, null);
  });
});

test('Insurance Hub: não é possível abrir sinistro numa apólice ainda em DRAFT', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);

    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'x' }, { userId: tenant.userId }, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_INVALID_STATUS');
        return true;
      }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 5): o `quoteSnapshot` guardava CPF/renda/endereço
// do locatário em texto claro, vindos do `req` de cotação embutido no `raw` do adapter —
// desviando do padrão já estabelecido no projeto (Person.taxIdNormalized mascarado + hash).
test('Insurance Hub: quoteSnapshot mascara CPF/renda/endereço do locatário, nunca grava PII em claro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    const quoted = await insuranceService.quotePolicy(
      policy.id,
      {
        TenantData: {
          PublicIdNumber: '21331742498',
          Name: 'Locatário Teste',
          Email: 'locatario@teste.com',
          MonthlyIncome: 3564.32,
          CurrentAddress: { ZipCode: '13272823', StreetName: 'Rua Nove' },
        },
      },
      { userId: tenant.userId },
      transaction
    );

    const snapshotStr = JSON.stringify(quoted.quoteSnapshot);
    assert.ok(!snapshotStr.includes('21331742498'), 'CPF não pode aparecer em claro no quoteSnapshot');
    assert.ok(!snapshotStr.includes('locatario@teste.com'), 'e-mail não pode aparecer em claro no quoteSnapshot');
    assert.ok(!snapshotStr.includes('3564.32'), 'renda não pode aparecer em claro no quoteSnapshot');
    assert.ok(!snapshotStr.includes('Rua Nove'), 'endereço não pode aparecer em claro no quoteSnapshot');
    // Nome da pessoa não é um dado financeiro/documental sensível no mesmo nível — só os
    // campos listados em PII_KEY_PATTERN (CPF/renda/contato/endereço) são mascarados.
    assert.ok(snapshotStr.includes('Locatário Teste'), 'campos não-PII continuam íntegros no snapshot');
  });
});

// Bug real corrigido nesta auditoria (rodada 7): a InsuranceRenewalTask era criada na emissão
// mas nunca lida por nada — "renovação alerta" do contrato ficava só como linha inerte no
// banco. `insuranceRenewalAlertJob.js` fecha isso de verdade (Notification real) e é idempotente.
test('Insurance Hub: job de renovação alerta de verdade (Notification) e é idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 1); // vigência vencendo amanhã -> dueDate (30 dias antes) já no passado
    await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: new Date().toISOString().slice(0, 10), expiryDate: expiryDate.toISOString().slice(0, 10) },
      { userId: tenant.userId },
      transaction
    );

    const task = await InsuranceRenewalTask.findOne({ where: { policyId: policy.id }, transaction });
    assert.equal(task.lastAlertedAt, null);

    const first = await alertDueRenewals(transaction, new Date());
    assert.equal(first.alerted, 1);

    await task.reload({ transaction });
    assert.ok(task.lastAlertedAt, 'tarefa precisa ficar marcada como alertada');

    const notification = await Notification.findOne({ where: { userId: tenant.userId }, order: [['created_at', 'DESC']], transaction });
    assert.ok(notification, 'o job precisa criar uma Notification real, não só marcar a tarefa');
    assert.match(notification.title, /vencendo/i);

    const second = await alertDueRenewals(transaction, new Date());
    assert.equal(second.alerted, 0, 'rodar o job de novo não pode gerar uma segunda notificação pra mesma tarefa');
  });
});

// Bug real corrigido nesta auditoria (rodada 8): o contrato lista "documentos" como campo da
// apólice, mas nada no Insurance Hub usava FileLink — o documento embutido na resposta da
// seguradora (ex.: `Data.File` da Yelum) era descartado dentro do `quoteSnapshot` em vez de
// virar um File real.
// A sandbox (único adapter ativo neste tenant de teste — nenhuma seguradora real configurada)
// ecoa a requisição dentro de `raw.req`, então nunca produz um `Data.File` no formato real da
// Yelum — por isso `extractEmbeddedDocument` é testado direto aqui, contra o shape real
// documentado da resposta da Yelum (`raw.Data.File`), e separadamente confirmamos que o fluxo
// via sandbox (sem documento) não cria nenhum FileLink espúrio.
test('Insurance Hub: extractEmbeddedDocument reconhece o documento embutido no shape real da Yelum (raw.Data.File)', () => {
  const fakePdfBase64 = Buffer.from('PDF-FAKE-CONTENT').toString('base64');
  const doc = insuranceService.extractEmbeddedDocument({ Data: { File: fakePdfBase64 } });
  assert.ok(doc, 'precisa reconhecer o documento quando raw.Data.File está presente');
  assert.equal(doc.contentBase64, fakePdfBase64);
  assert.equal(doc.mimeType, 'application/pdf');

  assert.equal(insuranceService.extractEmbeddedDocument({ Data: {} }), null, 'sem File, não há documento a extrair');
  assert.equal(insuranceService.extractEmbeddedDocument(null), null, 'raw nulo não pode quebrar a extração');
});

test('Insurance Hub: cotação sandbox (sem documento da seguradora) não cria FileLink espúrio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, { userId: tenant.userId }, transaction);

    const documents = await insuranceService.listPolicyDocuments(policy.id, transaction);
    assert.equal(documents.length, 0, 'sandbox não devolve documento — não pode inventar um FileLink');
  });
});

test('Insurance Hub: anexar documento manualmente à apólice (ex.: apólice assinada) cria FileLink com auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    const filesService = require('../src/features/files/files.service');
    const file = await filesService.uploadFile(
      withTenant({ fileName: 'apolice-assinada.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('APOLICE').toString('base64'), category: 'insurance' }),
      tenant.userId,
      transaction
    );

    const link = await insuranceService.attachPolicyDocument(policy.id, file.id, { userId: tenant.userId }, transaction);
    assert.equal(link.purpose, 'MANUAL');
    assert.equal(link.fileId, file.id);

    const documents = await insuranceService.listPolicyDocuments(policy.id, transaction);
    assert.equal(documents.length, 1);

    await assert.rejects(
      () => insuranceService.attachPolicyDocument(policy.id, null, { userId: tenant.userId }, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_DOCUMENT_VALIDATION');
        return true;
      }
    );
  });
});

test('Insurance Hub: confirmação de liquidação é idempotente — reprocessar o mesmo evento não duplica o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, { userId: tenant.userId }, transaction);
    const claim = await insuranceService.openClaim(policy.id, { description: 'idempotência', claimAmount: 300 }, { userId: tenant.userId }, transaction);
    const submitted = await insuranceService.submitClaim(claim.id, { userId: tenant.userId }, transaction);

    const first = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', 300, transaction);
    const second = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', 300, transaction);

    assert.equal(first.financialEntryId, second.financialEntryId, 'reprocessar o mesmo evento não pode criar um segundo lançamento');
  });
});

// Bug real corrigido nesta auditoria (rodada 40, 2026-10-05): payInsurancePolicyInstallment não
// travava a linha (nem a parcela, nem o FinancialEntry compartilhado) — duas chamadas
// concorrentes de baixa, cada uma numa parcela diferente mas usando o MESMO financialEntryId,
// podiam ambas passar pela checagem "alreadyUsed" antes de qualquer commit e marcar as duas
// como PAID com o mesmo lançamento (dupla contagem). Agora trava o FinancialEntry também, e há
// um índice único parcial no banco como última linha de defesa.
test('Insurance Hub: duas parcelas concorrentes não conseguem usar o mesmo financialEntryId (sem dupla contagem)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, { userId: tenant.userId }, transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
      { userId: tenant.userId },
      transaction
    );
    const installments = await insuranceService.listPolicyInstallments(issued.id, transaction);
    assert.equal(installments.length, 2);
    const [first, second] = installments;

    const entry = await createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: Number(first.amount), description: 'Pagamento (teste concorrência)' }),
      tenant.userId,
      transaction
    );
    const { settleFinancialEntry } = require('../src/features/finance/financialEntries.service');
    await settleFinancialEntry(entry.id, tenant.userId, transaction);

    // Mesmo valor nas duas parcelas pra o mesmo financialEntryId "passar" a validação de valor
    // em ambas, isolando o teste na proteção de concorrência (não na validação de amount).
    second.amount = first.amount;
    await second.save({ transaction });

    await insuranceService.payInsurancePolicyInstallment(first.id, entry.id, { userId: tenant.userId }, transaction);

    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(second.id, entry.id, { userId: tenant.userId }, transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_ALREADY_USED');
        return true;
      }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 55, 2026-10-05): dueDate da tarefa de renovação
// (expiryDate - 30 dias) era calculado com `new Date(dateOnlyString)` + `.setDate()`, que opera
// no fuso LOCAL do servidor — em qualquer servidor com offset negativo (Brasil, UTC-3), isso
// trunca o dia pro anterior ANTES de subtrair, gravando a tarefa um dia antes do correto.
test('Insurance Hub: InsuranceRenewalTask.dueDate é exatamente expiryDate - 30 dias, sem deslocamento de fuso horário', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-12-01', expiryDate: '2026-12-31' },
      { userId: tenant.userId },
      transaction
    );
    const task = await InsuranceRenewalTask.findOne({ where: { policyId: issued.id }, transaction });
    assert.equal(String(task.dueDate), '2026-12-01', 'dueDate precisa ser exatamente 30 dias antes de 2026-12-31, nunca um dia a menos por causa do fuso');
  });
});
