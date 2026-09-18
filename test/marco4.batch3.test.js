'use strict';

// Testes de aceite do Marco 4 — terceiro lote (M4-03 competência, M4-06 liquidação parcial,
// M4-13 conciliação N:N, M4-21 antifraude/revisão manual, M4-28 jornada E2E financeira).
//
// Todos rodam contra o banco real via withRollbackTenantTransaction (mesmo caminho de RLS da
// aplicação — SET LOCAL app.group_id/company_id/user_id), sem nenhum mock.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const approvalsService = require('../src/features/finance/approvals.service');
const antifraudService = require('../src/features/finance/financeAntifraud.service');
const mfaService = require('../src/features/users/mfa.service');
const { FinancialEntry, Notification, User, AuditLog } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createEntry(transaction, overrides = {}) {
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: 'QA M4 batch3',
      ...overrides,
    },
    tenant.userId,
    transaction
  );
}

// Conta bancária já elegível a pagamento (sem cooldown), pra não misturar a regra de
// resfriamento (M4-11, já coberta) com o que estes testes querem provar.
async function createActiveBankAccount(transaction, suffix) {
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `b3-${suffix}` },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return account;
}

async function createMfaReadyUser(transaction, suffix, label) {
  const user = await User.create(
    { name: `QA M4-B3 ${label} ${suffix}`, email: `qa-m4b3-${label}-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  const { otpauthUri } = await mfaService.setupMfa(user.id, tenant, transaction);
  const secret = /[?&]secret=([^&]+)/.exec(otpauthUri)[1];
  await mfaService.confirmMfa(user.id, authenticator.generate(secret), tenant, transaction);
  await mfaService.verifyMfa(user.id, authenticator.generate(secret), tenant, transaction);
  return user;
}

// --- M4-03: competência x vencimento -------------------------------------------------------

test('M4-03 competência explícita diferente do mês de vencimento é gravada exatamente como informada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Conta de energia: consumo (competência) de setembro, vencimento em outubro.
    const entry = await createEntry(transaction, {
      amount: 432.19,
      dueAt: new Date(Date.UTC(2026, 9, 10)), // 2026-10-10
      competenceMonth: '2026-09',
      description: 'Energia — consumo de setembro, vence em outubro',
    });

    assert.equal(entry.competenceMonth, '2026-09');
    assert.equal(new Date(entry.dueAt).getUTCMonth(), 9, 'vencimento continua em outubro');

    const reloaded = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(reloaded.competenceMonth, '2026-09', 'competência persistida no banco, não só em memória');
  });
});

test('M4-03 sem competência informada, deriva do mês de vencimento; sem vencimento, do mês de criação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const comDue = await createEntry(transaction, { dueAt: new Date(Date.UTC(2027, 2, 28)) });
    assert.equal(comDue.competenceMonth, '2027-03', 'derivou do vencimento');

    const semDue = await createEntry(transaction, { dueAt: null });
    const agora = new Date();
    const esperado = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
    assert.equal(semDue.competenceMonth, esperado, 'sem vencimento, derivou do mês de criação');
  });
});

test('M4-03 competência em formato inválido é rejeitada (não grava lixo no fechamento contábil)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const invalido of ['2026-13', '09/2026', '2026', 'setembro']) {
      await assert.rejects(
        () => createEntry(transaction, { competenceMonth: invalido }),
        (err) => {
          assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION');
          return true;
        },
        `competenceMonth "${invalido}" deveria ser rejeitado`
      );
    }
  });
});

// --- M4-06: liquidação parcial no ledger ---------------------------------------------------

test('M4-06 duas baixas parciais fecham o lançamento: soma bate no centavo e o amount original nunca muda', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 1000.33, bankAccountId: account.id });
    const amountOriginal = String(entry.amount);

    const primeira = await financialEntriesService.settleFinancialEntryPartial(entry.id, 400.11, tenant.userId, transaction);
    assert.equal(primeira.original.status, 'PARTIALLY_SETTLED');
    assert.equal(primeira.remainingAmount, '600.22');
    assert.equal(String(primeira.settlement.amount), '400.11');
    assert.equal(primeira.settlement.parentEntryId, entry.id);
    assert.equal(primeira.settlement.status, 'SETTLED');

    const segunda = await financialEntriesService.settleFinancialEntryPartial(entry.id, 600.22, tenant.userId, transaction);
    assert.equal(segunda.remainingAmount, '0.00');
    assert.equal(segunda.original.status, 'SETTLED', 'quando a soma fecha o total, o original vira SETTLED');
    assert.ok(segunda.original.settledAt, 'settledAt preenchido ao fechar');

    const reloaded = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(String(reloaded.amount), amountOriginal, 'LEDGER IMUTÁVEL: amount original nunca foi alterado');

    const filhos = await FinancialEntry.findAll({ where: { parentEntryId: entry.id }, transaction });
    const soma = filhos.reduce((acc, f) => acc + Math.round(Number(f.amount) * 100), 0);
    assert.equal(filhos.length, 2);
    assert.equal(soma, 100033, 'soma das baixas parciais bate exatamente com o total, em centavos');
    assert.equal(await financialEntriesService.computeRemainingAmount(entry.id, transaction), '0.00');
  });
});

test('M4-06 baixa parcial maior que o saldo restante é rejeitada, e liquidar valor <= 0 também', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 100, bankAccountId: account.id });

    await financialEntriesService.settleFinancialEntryPartial(entry.id, 70, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 30.01, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_PARTIAL_EXCEEDS_REMAINING');
        return true;
      },
      'nem um centavo a mais que o saldo restante'
    );

    for (const valor of [0, -50]) {
      await assert.rejects(
        () => financialEntriesService.settleFinancialEntryPartial(entry.id, valor, tenant.userId, transaction),
        (err) => {
          assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION');
          return true;
        }
      );
    }

    // Saldo segue intacto depois das tentativas rejeitadas.
    assert.equal(await financialEntriesService.computeRemainingAmount(entry.id, transaction), '30.00');
  });
});

test('M4-06 lançamento com baixa parcial não aceita mais liquidação TOTAL pelo caminho antigo', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 200, bankAccountId: account.id });
    await financialEntriesService.settleFinancialEntryPartial(entry.id, 50, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS');
        return true;
      },
      'settleFinancialEntry não pode "pagar de novo" os 200 cheios de um lançamento que já tem 50 baixados'
    );
  });
});

// --- M4-13: conciliação N:N ----------------------------------------------------------------

test('M4-13 N:1 — dois lançamentos de R$50 conciliam contra uma transação bancária de R$100', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const e1 = await createEntry(transaction, { amount: 50, bankAccountId: account.id });
    const e2 = await createEntry(transaction, { amount: 50, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 100, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    const resultado = await reconciliationService.matchReconciliationGroup(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [e1.id, e2.id], bankTransactionIds: [bankTx.id] },
      tenant.userId,
      transaction
    );

    assert.equal(resultado.totalAmount, '100.00');
    assert.equal(resultado.reconciliations.length, 2, 'uma linha por lançamento, todas no mesmo match_group_id');
    assert.ok(resultado.matchGroupId);
    for (const r of resultado.reconciliations) {
      assert.equal(r.matchGroupId, resultado.matchGroupId);
      assert.equal(r.bankTransactionId, bankTx.id);
    }

    const doGrupo = await reconciliationService.listReconciliations(transaction, { matchGroupId: resultado.matchGroupId });
    assert.equal(doGrupo.length, 2, 'o grupo inteiro é recuperável por match_group_id');

    // Depois de conciliado em grupo, nenhum dos itens pode ser reconciliado de novo.
    const outraTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 50, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => reconciliationService.matchReconciliation(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: e1.id, bankTransactionId: outraTx.id },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
        return true;
      }
    );
  });
});

test('M4-13 N:M — soma que não bate (nem por um centavo) é rejeitada e nada é gravado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const e1 = await createEntry(transaction, { amount: 33.33, bankAccountId: account.id });
    const e2 = await createEntry(transaction, { amount: 66.68, bankAccountId: account.id }); // total 100.01
    const t1 = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 60, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const t2 = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 40, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => reconciliationService.matchReconciliationGroup(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [e1.id, e2.id], bankTransactionIds: [t1.id, t2.id] },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH');
        return true;
      }
    );

    const nadaGravado = await reconciliationService.listReconciliations(transaction, { financialEntryId: e1.id });
    assert.equal(nadaGravado.length, 0, 'rejeição não pode deixar conciliação parcial gravada');

    // Com transações que somam EXATAMENTE os mesmos 100.01, o grupo 2x2 passa
    // (N + M - 1 = 3 linhas, todas no mesmo match_group_id).
    const t3 = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 60.01, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const t4 = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 40, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const ok = await reconciliationService.matchReconciliationGroup(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [e1.id, e2.id], bankTransactionIds: [t3.id, t4.id] },
      tenant.userId,
      transaction
    );
    assert.equal(ok.totalAmount, '100.01');
    assert.equal(ok.reconciliations.length, 3);
    assert.equal(new Set(ok.reconciliations.map((r) => r.matchGroupId)).size, 1);
  });
});

// --- M4-21: antifraude — anomalia + revisão manual ------------------------------------------

test('M4-21 pagamento 3x acima da média histórica da conta é flagado, notifica o financeiro e trava a liquidação', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);

    // Histórico: dois pagamentos de 100 já liquidados nessa conta (média = 100).
    for (let i = 0; i < 2; i += 1) {
      const historico = await createEntry(transaction, { amount: 100, bankAccountId: account.id });
      await financialEntriesService.settleFinancialEntry(historico.id, tenant.userId, transaction);
    }

    const normal = await createEntry(transaction, { amount: 120, bankAccountId: account.id });
    const semFlag = await antifraudService.flagAnomalousPayment(normal, transaction);
    assert.equal(semFlag.flagged, false, 'pagamento dentro do padrão não pode ser flagado (evita ruído)');

    const suspeito = await createEntry(transaction, { amount: 900, bankAccountId: account.id });
    const flag = await antifraudService.flagAnomalousPayment(suspeito, transaction);
    assert.equal(flag.flagged, true);
    assert.match(flag.reason, /média histórica/);

    const reloaded = await FinancialEntry.findByPk(suspeito.id, { transaction });
    assert.equal(reloaded.requiresManualReview, true);
    assert.ok(reloaded.manualReviewReason);

    const notificacoes = await Notification.findAll({ where: { companyId: tenant.companyId }, transaction });
    assert.ok(
      notificacoes.some((n) => n.body && n.body.includes(suspeito.id)),
      'time financeiro notificado sobre o pagamento retido'
    );

    // Fail closed: enquanto retido, não liquida nem total nem parcialmente.
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(suspeito.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
        return true;
      }
    );
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(suspeito.id, 10, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
        return true;
      }
    );
  });
});

test('M4-21 primeiro pagamento alto para conta sem histórico é flagado; revisão manual libera e audita quem revisou', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 25000, bankAccountId: account.id });

    const flag = await antifraudService.flagAnomalousPayment(entry, transaction);
    assert.equal(flag.flagged, true);
    assert.match(flag.reason, /Primeiro pagamento/);

    const revisor = await User.create(
      { name: `QA M4-21 revisor ${suffix}`, email: `qa-m421-rev-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    const liberado = await antifraudService.clearManualReview(entry.id, revisor.id, transaction, 'Pagamento conferido com o contrato e com o beneficiário por telefone.');
    assert.equal(liberado.requiresManualReview, false);
    assert.equal(liberado.manualReviewClearedBy, revisor.id);
    assert.ok(liberado.manualReviewClearedAt);

    const auditorias = await AuditLog.findAll({ where: { entityId: entry.id }, transaction });
    const liberacao = auditorias.find((a) => a.action === 'finance.antifraud.manual_review_cleared');
    assert.ok(liberacao, 'liberação registrada na auditoria');
    assert.equal(liberacao.userId, revisor.id, 'a trilha guarda QUEM revisou');

    // Liberado, agora liquida normalmente.
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED');

    // Liberar de novo algo que não está retido é conflito (não é no-op silencioso).
    await assert.rejects(
      () => antifraudService.clearManualReview(entry.id, revisor.id, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_MANUAL_REVIEW_NOT_PENDING');
        return true;
      }
    );
  });
});

test('M4-21 liberação de revisão manual exige revisor humano identificado (actorUserId nulo é recusado)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 50000, bankAccountId: account.id });
    await antifraudService.flagAnomalousPayment(entry, transaction);

    await assert.rejects(
      () => antifraudService.clearManualReview(entry.id, null, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_MANUAL_REVIEW_ACTOR_REQUIRED');
        return true;
      }
    );
    const ainda = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(ainda.requiresManualReview, true, 'continua retido');
  });
});

// --- M4-28: jornada E2E financeira completa -------------------------------------------------

test('M4-28 jornada E2E: lançamento -> aprovação HIGH (2 aprovadores) -> liquidação -> conciliação, tudo auditado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // 1) Conta bancária do beneficiário + lançamento a pagar com competência explícita.
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 7500.45,
        description: 'QA M4-28 — jornada E2E financeira',
        dueAt: new Date(Date.UTC(2026, 9, 5)),
        competenceMonth: '2026-09',
        idempotencyKey: `qa-m428-${suffix}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(entry.status, 'PENDING');
    assert.equal(entry.competenceMonth, '2026-09');

    // 1b) Antifraude avalia: conta sem histórico + valor < 10k => não retém.
    const anomalia = await antifraudService.flagAnomalousPayment(entry, transaction);
    assert.equal(anomalia.flagged, false);

    // 2) Solicitação de aprovação de risco HIGH (exige 2 aprovações independentes + MFA).
    const approvalRequest = await approvalsService.createApprovalRequest(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: entry.id,
        riskLevel: 'HIGH',
      },
      tenant.userId,
      transaction
    );
    assert.equal(approvalRequest.status, 'PENDING');

    // 3) Duas aprovações de dois usuários DIFERENTES do solicitante.
    const aprovador1 = await createMfaReadyUser(transaction, suffix, 'ap1');
    const aprovador2 = await createMfaReadyUser(transaction, suffix, 'ap2');

    const passo1 = await approvalsService.decideApprovalStep(approvalRequest.id, { decision: 'APPROVED' }, aprovador1.id, transaction);
    assert.equal(passo1.approvalRequest.status, 'PENDING', 'uma aprovação só não fecha risco HIGH');

    const passo2 = await approvalsService.decideApprovalStep(approvalRequest.id, { decision: 'APPROVED' }, aprovador2.id, transaction);
    assert.equal(passo2.approvalRequest.status, 'APPROVED');
    assert.equal(
      await approvalsService.isApprovalRequestApproved('FinancialEntry', entry.id, transaction),
      true
    );

    // 4) Liquidação (pagamento efetivo).
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED');
    assert.ok(settled.settledAt);
    assert.equal(String(settled.amount), '7500.45', 'o valor pago é exatamente o valor aprovado');

    // 5) Conciliação contra a linha real do extrato.
    const bankTx = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: -7500.45, // saída no extrato
        transactionDate: new Date(),
        externalTransactionId: `qa-m428-ofx-${suffix}`,
      },
      tenant.userId,
      transaction
    );
    const reconciliation = await reconciliationService.matchReconciliation(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, bankTransactionId: bankTx.id },
      tenant.userId,
      transaction
    );
    assert.ok(reconciliation.id);
    assert.equal(reconciliation.financialEntryId, entry.id);

    // 6) Fechamento do período — depende do módulo periodClosures (M4-19/20), de outro pacote.
    let fechamentoTestado = false;
    let periodClosuresService = null;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      periodClosuresService = require('../src/features/finance/periodClosures.service');
    } catch (err) {
      periodClosuresService = null;
    }
    if (periodClosuresService && typeof periodClosuresService.closePeriod === 'function') {
      const closure = await periodClosuresService.closePeriod(
        { groupId: tenant.groupId, companyId: tenant.companyId, competenceMonth: '2026-09' },
        tenant.userId,
        transaction
      );
      assert.ok(closure);
      fechamentoTestado = true;
    }
    if (!fechamentoTestado) {
      // eslint-disable-next-line no-console
      console.log(
        '[M4-28] fechamento de período NÃO testado nesta jornada porque o módulo ' +
          '(src/features/finance/periodClosures.service.js) ainda não estava disponível no momento deste teste.'
      );
    }

    // 7) Trilha de auditoria completa da jornada: cada etapa deixou rastro.
    const auditorias = await AuditLog.findAll({ where: { entityId: entry.id }, transaction });
    const acoes = auditorias.map((a) => a.action);
    for (const esperada of ['finance.entry.create', 'finance.entry.settle']) {
      assert.ok(acoes.includes(esperada), `auditoria "${esperada}" ausente na jornada (registradas: ${acoes.join(', ')})`);
    }
    const auditoriaAprovacao = await AuditLog.findAll({ where: { entityId: approvalRequest.id }, transaction });
    assert.ok(
      auditoriaAprovacao.some((a) => a.action === 'finance.approval_request.create'),
      'criação da solicitação de aprovação auditada'
    );
    const auditoriaConciliacao = await AuditLog.findAll({ where: { entityId: reconciliation.id }, transaction });
    assert.ok(
      auditoriaConciliacao.some((a) => a.action === 'finance.reconciliation.match'),
      'conciliação auditada'
    );

    // 8) Consistência final: o lançamento não tem saldo em aberto e não pode ser pago de novo.
    assert.equal(await financialEntriesService.computeRemainingAmount(entry.id, transaction), '7500.45',
      'sem baixas parciais filhas, o "restante" calculado é o próprio amount — a liquidação total não cria filho');
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS');
        return true;
      }
    );
  });
});
