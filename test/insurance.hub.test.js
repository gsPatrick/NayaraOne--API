'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestCostCenter } = require('./testHelpers');
const { FinancialEntry, InsuranceRenewalTask, Notification } = require('../src/models');
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

    const quoted = await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    assert.equal(quoted.status, 'QUOTED');
    assert.ok(quoted.premiumAmount);

    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.equal(issued.status, 'ACTIVE');
    assert.equal(issued.provider, 'sandbox');

    const claim = await insuranceService.openClaim(
      policy.id,
      { description: 'teste automatizado', claimAmount: 1500 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.equal(claim.status, 'OPEN');

    const submitted = await insuranceService.submitClaim(claim.id, withTenant({ userId: tenant.userId }), transaction);
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, withTenant({ userId: tenant.userId }), transaction);
    const claim = await insuranceService.openClaim(policy.id, { description: 'teste rejeitado', claimAmount: 500 }, withTenant({ userId: tenant.userId }), transaction);
    const submitted = await insuranceService.submitClaim(claim.id, withTenant({ userId: tenant.userId }), transaction);

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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, withTenant({ userId: tenant.userId }), transaction);
    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'valor inválido', claimAmount: -100 }, withTenant({ userId: tenant.userId }), transaction),
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 3 },
      withTenant({ userId: tenant.userId }),
      transaction
    );

    const installments = await insuranceService.listPolicyInstallments(issued.id, transaction);
    assert.equal(installments.length, 3, 'issuePolicy precisa gerar as 3 parcelas pedidas');
    const sum = installments.reduce((acc, i) => acc + Number(i.amount), 0);
    assert.ok(Math.abs(sum - Number(issued.premiumAmount)) < 0.01, 'soma das parcelas precisa bater com o prêmio (sem perder centavos no arredondamento)');
    assert.ok(installments.every((i) => i.status === 'PENDING'));

    // ATUALIZADO (auditoria Marco 7 Compras E2E, 2026-10-18): a parcela agora nasce com o
    // PRÓPRIO payable vinculado (financialEntryId) — a baixa só aceita exatamente esse
    // lançamento. Um entry avulso (mesmo PAYABLE de mesmo valor) é rejeitado como NOT_LINKED,
    // e a baixa legítima usa o lançamento vinculado após liquidá-lo.
    const firstInstallment = installments[0];
    assert.ok(firstInstallment.financialEntryId, 'parcela nasce vinculada ao próprio payable do prêmio');
    const costCenter1 = await createTestCostCenter(tenant, transaction);
    const intruderEntry = await createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: Number(firstInstallment.amount), description: 'Pagamento de parcela de seguro (teste)', costCenterId: costCenter1.id }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, intruderEntry.id, withTenant({ userId: tenant.userId }), transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_LINKED');
        return true;
      }
    );

    // O lançamento vinculado ainda não liquidado também não baixa (fail-closed preservado).
    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, firstInstallment.financialEntryId, withTenant({ userId: tenant.userId }), transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_SETTLED');
        return true;
      }
    );

    const { settleFinancialEntryWithApproval } = require('./testHelpers');
    await settleFinancialEntryWithApproval(tenant, firstInstallment.financialEntryId, tenant.userId, transaction);
    const paid = await insuranceService.payInsurancePolicyInstallment(firstInstallment.id, firstInstallment.financialEntryId, withTenant({ userId: tenant.userId }), transaction);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.financialEntryId, firstInstallment.financialEntryId);

    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, firstInstallment.financialEntryId, withTenant({ userId: tenant.userId }), transaction),
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, withTenant({ userId: tenant.userId }), transaction);
    // Sinistro aberto SEM claimAmount (campo opcional) — e confirmação sem settledAmount.
    const claim = await insuranceService.openClaim(policy.id, { description: 'sem valor nenhum' }, withTenant({ userId: tenant.userId }), transaction);
    const submitted = await insuranceService.submitClaim(claim.id, withTenant({ userId: tenant.userId }), transaction);

    const result = await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', null, transaction);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.financialEntryId, null);
  });
});

test('Insurance Hub: não é possível abrir sinistro numa apólice ainda em DRAFT', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);

    await assert.rejects(
      () => insuranceService.openClaim(policy.id, { description: 'x' }, withTenant({ userId: tenant.userId }), transaction),
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
        estimatedValue: 10000,
        TenantData: {
          PublicIdNumber: '21331742498',
          Name: 'Locatário Teste',
          Email: 'locatario@teste.com',
          MonthlyIncome: 3564.32,
          CurrentAddress: { ZipCode: '13272823', StreetName: 'Rua Nove' },
        },
      },
      withTenant({ userId: tenant.userId }),
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: new Date().toISOString().slice(0, 10), expiryDate: expiryDate.toISOString().slice(0, 10) },
      withTenant({ userId: tenant.userId }),
      transaction
    );

    const task = await InsuranceRenewalTask.findOne({ where: { policyId: policy.id }, transaction });
    assert.equal(task.lastAlertedAt, null);

    const first = await alertDueRenewals(transaction, new Date());
    assert.equal(first.alerted, 1);

    await task.reload({ transaction });
    assert.ok(task.lastAlertedAt, 'tarefa precisa ficar marcada como alertada');

    const notification = await Notification.findOne({ where: withTenant({ userId: tenant.userId }), order: [['created_at', 'DESC']], transaction });
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);

    const documents = await insuranceService.listPolicyDocuments(policy.id, tenant.groupId, tenant.companyId, transaction);
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

    const link = await insuranceService.attachPolicyDocument(policy.id, file.id, withTenant({ userId: tenant.userId }), transaction);
    assert.equal(link.purpose, 'MANUAL');
    assert.equal(link.fileId, file.id);

    const documents = await insuranceService.listPolicyDocuments(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(documents.length, 1);

    await assert.rejects(
      () => insuranceService.attachPolicyDocument(policy.id, null, withTenant({ userId: tenant.userId }), transaction),
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, withTenant({ userId: tenant.userId }), transaction);
    const claim = await insuranceService.openClaim(policy.id, { description: 'idempotência', claimAmount: 300 }, withTenant({ userId: tenant.userId }), transaction);
    const submitted = await insuranceService.submitClaim(claim.id, withTenant({ userId: tenant.userId }), transaction);

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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    const installments = await insuranceService.listPolicyInstallments(issued.id, transaction);
    assert.equal(installments.length, 2);
    const [first, second] = installments;

    // ATUALIZADO (auditoria Marco 7 Compras E2E, 2026-10-18): as parcelas agora nascem cada uma
    // com o PRÓPRIO payable vinculado (financialEntryId, índice único no banco). A dupla
    // contagem ficou impossível por construção em DUAS camadas, e o teste prova as duas:
    // (1) apontar a segunda parcela pro lançamento da primeira é rejeitado pelo índice único do
    //     banco (última linha de defesa, nem dado corrompido consegue);
    // (2) na API, dar baixa na segunda parcela com o lançamento da primeira cai em NOT_LINKED
    //     (a baixa só aceita o lançamento da própria parcela).
    const { InsuranceInstallment } = require('../src/models');

    await assert.rejects(
      () => InsuranceInstallment.update(
        { financialEntryId: first.financialEntryId },
        { where: { id: second.id }, transaction }
      ),
      (err) => {
        assert.equal(err.name, 'SequelizeUniqueConstraintError');
        return true;
      },
      'o índice único do banco precisa impedir duas parcelas apontando pro mesmo lançamento'
    );
  });
});

test('Insurance Hub: baixa da 2ª parcela com o lançamento da 1ª é rejeitada (NOT_LINKED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    const [first, second] = await insuranceService.listPolicyInstallments(issued.id, transaction);

    const { settleFinancialEntryWithApproval } = require('./testHelpers');
    await settleFinancialEntryWithApproval(tenant, first.financialEntryId, tenant.userId, transaction);
    await insuranceService.payInsurancePolicyInstallment(first.id, first.financialEntryId, withTenant({ userId: tenant.userId }), transaction);

    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(second.id, first.financialEntryId, withTenant({ userId: tenant.userId }), transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_LINKED');
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
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-12-01', expiryDate: '2026-12-31' },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    const task = await InsuranceRenewalTask.findOne({ where: { policyId: issued.id }, transaction });
    assert.equal(String(task.dueDate), '2026-12-01', 'dueDate precisa ser exatamente 30 dias antes de 2026-12-31, nunca um dia a menos por causa do fuso');
  });
});

// Bug real corrigido nesta auditoria (Ciclo 1 "loop até secar", Seguros, 2026-10-06): issuePolicy
// nunca validava a vigência informada — expiryDate igual/anterior a effectiveDate (ou uma data
// não-parseável) era aceita de cara, deixando a apólice "ativa" com janela de vigência vazia ou
// invertida, o que corrompe silenciosamente o cálculo de dueDate da renewal task (expiryDate -
// 30 dias) e a geração de parcelas.
test('Insurance Hub: issuePolicy rejeita vigência inválida (expiryDate <= effectiveDate)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    // issuePolicy agora exige premiumAmount definido (INSURANCE_POLICY_MISSING_PREMIUM) — cota
    // antes pra garantir que as rejeições abaixo cheguem na validação de vigência que o teste
    // quer provar, não na checagem de prêmio.
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-12-31', expiryDate: '2026-12-01' },
        withTenant({ userId: tenant.userId }),
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'expiryDate anterior a effectiveDate precisa ser rejeitado'
    );

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-12-01', expiryDate: '2026-12-01' },
        withTenant({ userId: tenant.userId }),
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'expiryDate igual a effectiveDate (vigência vazia) precisa ser rejeitado'
    );

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-12-01', expiryDate: 'data-invalida' },
        withTenant({ userId: tenant.userId }),
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'expiryDate não-parseável precisa ser rejeitado'
    );

    // Confirma que a apólice não foi corrompida por nenhuma das tentativas rejeitadas: ainda
    // QUOTED (cotada no setup acima, pra issuePolicy não barrar por falta de prêmio antes de
    // chegar na validação de vigência que este teste quer provar), sem vigência gravada, e
    // emitir com vigência válida continua funcionando no mesmo registro.
    const stillDraft = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(stillDraft.status, 'QUOTED');
    assert.equal(stillDraft.effectiveDate, null);

    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-12-01', expiryDate: '2026-12-31' },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.ok(['ISSUED', 'ACTIVE'].includes(issued.status));
  });
});

// Achados reais — auditoria Nayara (Claude Browser), 2026-10-14, Marco 7 (F6/F7):
// F6a — "Cotar" sobrescrevia a cobertura digitada pelo usuário com o texto fixo do adapter
// sandbox ("Cotação simulada..."), perda silenciosa de dado.
// F6b — cotar sem "estimatedValue" era aceito e caía no prêmio fixo de fallback (R$ 100), sem
// nenhum aviso ao usuário de que o valor não foi considerado.
// F7 — o motivo do cancelamento ficava só no audit log, nunca exposto de volta na apólice.
test('Insurance Hub: cotar preserva a cobertura digitada pelo usuário (não sobrescreve com o texto do adapter)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(
      withTenant({ coverageSummary: 'AUDIT M7 Seguro-fianca ficticio — Casa 7' }),
      tenant.userId,
      transaction
    );
    const quoted = await insuranceService.quotePolicy(
      policy.id,
      { estimatedValue: 50000 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.equal(quoted.coverageSummary, 'AUDIT M7 Seguro-fianca ficticio — Casa 7');
  });
});

test('Insurance Hub: cotar sem estimatedValue (ausente, zero ou negativo) é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    for (const bad of [{}, { estimatedValue: 0 }, { estimatedValue: -1 }, { estimatedValue: 'abc' }]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => insuranceService.quotePolicy(policy.id, bad, withTenant({ userId: tenant.userId }), transaction),
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
          return true;
        },
        `estimatedValue ${JSON.stringify(bad)} precisa ser rejeitado`
      );
    }
  });
});

test('Insurance Hub: cancelar apólice expõe motivo/data no getPolicy depois de salvo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.cancelPolicy(
      policy.id,
      { reason: 'Imóvel vendido, apólice não é mais necessária' },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    const reloaded = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    const json = reloaded.toJSON();
    assert.equal(json.status, 'CANCELED');
    assert.ok(json.cancelInfo, 'cancelInfo precisa vir preenchido numa apólice cancelada');
    assert.equal(json.cancelInfo.reason, 'Imóvel vendido, apólice não é mais necessária');
    assert.ok(json.cancelInfo.occurredAt, 'cancelInfo.occurredAt precisa estar presente');
  });
});

// BUG REAL CORRIGIDO (revalidação Marco 7, 14/10/2026): listPolicies (usado na tela de listagem
// e na busca por segurado) não incluía `parties` — só getPolicy (detalhe) incluía. A coluna
// "Cobertura/Segurado" e a busca textual por nome do segurado no front nunca encontravam nada,
// mesmo com o segurado cadastrado de verdade, porque `row.parties` vinha sempre undefined.
test('Insurance Hub: listPolicies traz "parties" (segurado) — não só getPolicy', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { Person } = require('../src/models');
    const person = await Person.create(
      withTenant({ personType: 'PF', legalName: 'AUDIT Segurado Teste Listagem' }),
      { transaction }
    );
    await insuranceService.createPolicy(
      withTenant({ parties: [{ personId: person.id, partyRole: 'INSURED' }] }),
      tenant.userId,
      transaction
    );
    const list = await insuranceService.listPolicies({}, tenant.groupId, tenant.companyId, transaction);
    const found = list.find((p) => (p.parties || []).some((party) => party.personId === person.id));
    assert.ok(found, 'a apólice recém-criada com segurado precisa aparecer na listagem já com "parties" preenchido');
    assert.equal(found.parties[0].partyRole, 'INSURED');
  });
});

// BUG GRAVE REAL CORRIGIDO (auditoria Marco 7 "final/reconfirmação", 16/10/2026): issuePolicy
// aceitava emitir direto de DRAFT (sem nunca ter cotado) — a apólice virava ACTIVE mas
// premiumAmount nunca tinha sido definido (só quotePolicy seta esse campo), e
// generateInstallments gerava ZERO parcelas silenciosamente. Usuário via apólice "Ativa" sem
// nenhuma parcela e sem aviso nenhum do porquê.
test('Insurance Hub: issuePolicy recusa emitir apólice sem premiumAmount (sem ter cotado antes)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    assert.equal(policy.status, 'DRAFT');
    assert.equal(policy.premiumAmount, null, 'apólice recém-criada não tem prêmio definido ainda');

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
        withTenant({ userId: tenant.userId }),
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'INSURANCE_POLICY_MISSING_PREMIUM');
        return true;
      },
      'emitir sem cotar (sem premiumAmount) precisa ser recusado, nunca gerar apólice ACTIVE com zero parcelas'
    );

    const reloaded = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(reloaded.status, 'DRAFT', 'a tentativa rejeitada não pode ter mudado o status da apólice');
  });
});

test('Insurance Hub: issuePolicy funciona normalmente depois de cotar (fluxo correto)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 5000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.equal(issued.status, 'ACTIVE');
    const installments = await insuranceService.listPolicyInstallments(issued.id, transaction);
    assert.equal(installments.length, 2, 'apólice cotada e emitida precisa gerar as parcelas pedidas');
  });
});
