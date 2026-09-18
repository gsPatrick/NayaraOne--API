'use strict';

// Testes de aceite do Marco 4 — Financeiro, terceiro lote:
// M4-01 (plano de contas), M4-07 (payment intent com snapshot+hash), M4-16 (segregação de
// dinheiro de terceiro), M4-18 (transferência entre empresas), M4-19/M4-20 (fechamento de
// período + relatório de saúde financeira) e M4-25 (replay sem duplicidade).
//
// Todos os testes rodam contra o banco real de homologação, pelo usuário de privilégio mínimo
// (nayara_runtime), dentro de transações com SET LOCAL app.group_id/company_id/user_id — ou
// seja, exercitam o RLS de verdade, não um bypass de teste.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const chartOfAccountsService = require('../src/features/finance/chartOfAccounts.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const intercompanyTransfersService = require('../src/features/finance/intercompanyTransfers.service');
const periodClosuresService = require('../src/features/finance/periodClosures.service');
const financialHealthReportService = require('../src/features/finance/financialHealthReport.service');
const { publishFinancialEntryCreated } = require('../src/features/finance/financeEvents.service');
const { Company, FinancialEntry, OutboxEvent, User } = require('../src/models');

let tenant;

/**
 * withCommittedTenantTransaction — transação REAL com commit (não rollback), necessária para
 * provar comportamento ENTRE transações distintas (é o caso do replay do M4-25: reprocessar o
 * mesmo evento numa transação nova, depois que a primeira já commitou). Mesmo padrão local de
 * test/marco4.acceptance.batch2.test.js.
 */
async function withCommittedTenantTransaction(tenantCtx, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantCtx.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantCtx.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantCtx.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Troca o contexto de empresa dentro de uma transação já aberta (para inspecionar o outro lado
 *  de uma transferência entre empresas sob o RLS da empresa de destino). */
async function withCompanyContext(transaction, companyId, fn) {
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId }, transaction });
  try {
    return await fn();
  } finally {
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  }
}

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// ---------------------------------------------------------------------------------------
// M4-01 — Plano de contas
// ---------------------------------------------------------------------------------------

test('M4-01 cria hierarquia de contas, vincula lançamento e filtra a listagem por conta contábil', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const base = { groupId: tenant.groupId, companyId: tenant.companyId };

    const root = await chartOfAccountsService.createAccount(
      { ...base, code: `4-${suffix}`, name: 'Receitas', accountType: 'REVENUE' },
      tenant.userId,
      transaction
    );
    const child = await chartOfAccountsService.createAccount(
      { ...base, code: `4.1-${suffix}`, name: 'Receitas de administração', accountType: 'REVENUE', parentAccountId: root.id },
      tenant.userId,
      transaction
    );
    const leaf = await chartOfAccountsService.createAccount(
      { ...base, code: `4.1.01-${suffix}`, name: 'Taxa de administração de locação', accountType: 'REVENUE', parentAccountId: child.id },
      tenant.userId,
      transaction
    );

    assert.equal(child.parentAccountId, root.id);
    assert.equal(leaf.parentAccountId, child.id);

    // Filhas diretas da raiz: exatamente a conta intermediária.
    const directChildren = await chartOfAccountsService.listAccounts(transaction, { parentId: root.id });
    assert.deepEqual(directChildren.map((a) => a.id), [child.id]);

    // Natureza contábil é herdada — pendurar uma despesa sob uma receita não pode passar.
    await assert.rejects(
      () =>
        chartOfAccountsService.createAccount(
          { ...base, code: `4.2-${suffix}`, name: 'Despesa errada', accountType: 'EXPENSE', parentAccountId: root.id },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_CHART_ACCOUNT_TYPE_MISMATCH'); return true; }
    );

    // Lançamento vinculado à conta analítica.
    const linked = await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1200, description: `M4-01 vinculado ${suffix}`, chartOfAccountId: leaf.id },
      tenant.userId,
      transaction
    );
    assert.equal(linked.chartOfAccountId, leaf.id);

    // Lançamento SEM plano de contas continua funcionando (coluna nullable — não quebra o legado).
    const unlinked = await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 800, description: `M4-01 sem conta ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(unlinked.chartOfAccountId, null);

    // Listagem filtrada por conta traz só o vinculado.
    const filtered = await financialEntriesService.listFinancialEntries(transaction, { chartOfAccountId: leaf.id });
    assert.deepEqual(filtered.map((e) => e.id), [linked.id]);

    // Conta com lançamento vinculado NUNCA é excluída — é desativada, e passa a recusar
    // lançamento novo sem apagar nada do histórico.
    const deactivated = await chartOfAccountsService.deactivateAccount(leaf.id, tenant.userId, transaction);
    assert.equal(deactivated.isActive, false);

    const stillThere = await financialEntriesService.getFinancialEntry(linked.id, transaction);
    assert.equal(stillThere.chartOfAccountId, leaf.id, 'lançamento histórico continua apontando para a conta desativada');

    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, chartOfAccountId: leaf.id },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_CHART_ACCOUNT_INACTIVE'); return true; }
    );

    // Pai com filha ativa não pode ser desativado (senão sobraria filha ativa sob pai inativo).
    await assert.rejects(
      () => chartOfAccountsService.deactivateAccount(root.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_CHART_ACCOUNT_HAS_ACTIVE_CHILDREN'); return true; }
    );
  });
});

// ---------------------------------------------------------------------------------------
// M4-07 — Payment intent com snapshot e hash
// ---------------------------------------------------------------------------------------

test('M4-07 approvePaymentIntent recusa quando o lançamento mudou depois do snapshot (hash divergente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 2500,
        description: `M4-07 original ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.snapshotJson.amount, '2500.00');
    assert.equal(
      intent.snapshotHash,
      paymentIntentsService.computeSnapshotHash(intent.snapshotJson),
      'o hash gravado tem que ser o SHA-256 do snapshot gravado'
    );

    const approver = await User.create(
      { name: `HOMO QA M4-07 aprovador ${suffix}`, email: `homo-qa-m407-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    // O lançamento muda DEPOIS do snapshot: o que seria aprovado já não é o que foi proposto.
    await financialEntriesService.updateFinancialEntry(
      entry.id,
      { description: `M4-07 ALTERADO ${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => paymentIntentsService.approvePaymentIntent(intent.id, approver.id, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_PAYMENT_INTENT_STALE');
        assert.ok(err.details.changedFields.includes('description'), 'o erro precisa dizer qual campo divergiu');
        return true;
      },
      'aprovar um snapshot que não bate mais com o lançamento tem que ser recusado'
    );

    const untouched = await financialEntriesService.getFinancialEntry(entry.id, transaction);
    assert.equal(untouched.status, 'PENDING', 'nada pode ter sido liquidado');
  });
});

test('M4-07 fluxo feliz: create -> approve (sem alteração) -> execute liquida o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 990.5,
        description: `M4-07 feliz ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);

    const approver = await User.create(
      { name: `HOMO QA M4-07 ok ${suffix}`, email: `homo-qa-m407ok-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    // Maker-checker: quem criou a intenção não aprova a própria intenção.
    await assert.rejects(
      () => paymentIntentsService.approvePaymentIntent(intent.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN'); return true; }
    );

    const approved = await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approvedByUserId, approver.id);

    const { intent: executed, entry: settled } = await paymentIntentsService.executePaymentIntent(
      intent.id,
      approver.id,
      transaction
    );
    assert.equal(executed.status, 'EXECUTED');
    assert.equal(settled.status, 'SETTLED');
    assert.ok(settled.settledAt, 'liquidação precisa carimbar settled_at');

    // Executar de novo não pode liquidar nada duas vezes.
    await assert.rejects(
      () => paymentIntentsService.executePaymentIntent(intent.id, approver.id, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PAYMENT_INTENT_NOT_APPROVED'); return true; }
    );
  });
});

// ---------------------------------------------------------------------------------------
// M4-16 — Segregação de dinheiro de terceiros (caução)
// ---------------------------------------------------------------------------------------

test('M4-16 dinheiro de terceiro exige referência e nunca entra na soma de receita própria', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE' };

    // Sem referência: recusado.
    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          { ...base, amount: 3000, description: `M4-16 caucao sem ref ${suffix}`, isThirdPartyFunds: true },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_THIRD_PARTY_REFERENCE_REQUIRED'); return true; }
    );

    // Referência só com espaços também não vale.
    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          { ...base, amount: 3000, isThirdPartyFunds: true, thirdPartyReference: '   ' },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_THIRD_PARTY_REFERENCE_REQUIRED'); return true; }
    );

    const caucao = await financialEntriesService.createFinancialEntry(
      {
        ...base,
        amount: 3000,
        description: `M4-16 caucao ${suffix}`,
        isThirdPartyFunds: true,
        thirdPartyReference: `Caução contrato ${suffix}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(caucao.isThirdPartyFunds, true);
    assert.equal(caucao.thirdPartyReference, `Caução contrato ${suffix}`);

    const receitaPropria = await financialEntriesService.createFinancialEntry(
      { ...base, amount: 450, description: `M4-16 taxa adm ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(receitaPropria.isThirdPartyFunds, false);

    const terceiros = await financialEntriesService.listFinancialEntries(transaction, { isThirdPartyFunds: true });
    const proprios = await financialEntriesService.listFinancialEntries(transaction, { isThirdPartyFunds: false });

    const terceirosIds = terceiros.map((e) => e.id);
    const propriosIds = proprios.map((e) => e.id);

    assert.ok(terceirosIds.includes(caucao.id), 'a caução tem que aparecer no grupo de dinheiro de terceiro');
    assert.ok(!terceirosIds.includes(receitaPropria.id));
    assert.ok(propriosIds.includes(receitaPropria.id), 'a taxa de administração é receita própria');
    assert.ok(!propriosIds.includes(caucao.id), 'a caução NUNCA pode aparecer como receita própria');

    // Todo lançamento do grupo "terceiros" tem referência preenchida — a regra vale pro conjunto.
    for (const entry of terceiros) {
      assert.ok(
        entry.thirdPartyReference && entry.thirdPartyReference.trim().length > 0,
        `lançamento ${entry.id} marcado como terceiro sem referência`
      );
    }

    // Os dois grupos são disjuntos por construção.
    assert.equal(
      terceirosIds.filter((id) => propriosIds.includes(id)).length,
      0,
      'nenhum lançamento pode estar nos dois grupos ao mesmo tempo'
    );
  });
});

// ---------------------------------------------------------------------------------------
// M4-18 — Transferência formal entre empresas
// ---------------------------------------------------------------------------------------

test('M4-18 createIntercompanyTransfer gera exatamente 2 lançamentos, um em cada empresa, com valores batendo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();

    // Segunda empresa do MESMO grupo (core.companies tem RLS por group_id).
    const destination = await Company.create(
      { groupId: tenant.groupId, name: `HOMO QA M4-18 Destino ${suffix}`, status: 'ACTIVE' },
      { transaction }
    );

    const { transfer, fromEntry, toEntry } = await intercompanyTransfersService.createIntercompanyTransfer(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        toCompanyId: destination.id,
        amount: 7500,
        reason: `Rateio administrativo ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    assert.equal(transfer.status, 'PENDING');
    assert.equal(transfer.companyId, tenant.companyId, 'company_id da transferência é a empresa de ORIGEM (decisão de RLS)');
    assert.equal(transfer.fromCompanyId, tenant.companyId);
    assert.equal(transfer.toCompanyId, destination.id);
    assert.equal(Number(transfer.amount), 7500);

    // Exatamente 2 lançamentos, um de cada lado, mesmo valor, natureza ADJUSTMENT.
    assert.notEqual(fromEntry.id, toEntry.id);
    assert.equal(transfer.fromEntryId, fromEntry.id);
    assert.equal(transfer.toEntryId, toEntry.id);

    assert.equal(fromEntry.companyId, tenant.companyId);
    assert.equal(fromEntry.entryType, 'DEBIT');
    assert.equal(fromEntry.nature, 'ADJUSTMENT');
    assert.equal(Number(fromEntry.amount), 7500);

    assert.equal(toEntry.companyId, destination.id);
    assert.equal(toEntry.entryType, 'CREDIT');
    assert.equal(toEntry.nature, 'ADJUSTMENT');
    assert.equal(Number(toEntry.amount), 7500);
    assert.equal(Number(fromEntry.amount), Number(toEntry.amount), 'as duas pernas têm que ter o mesmo valor');

    // O lançamento de entrada existe DE FATO sob o RLS da empresa de destino (não é um objeto
    // em memória: relemos do banco com app.company_id apontando pra empresa destino).
    const persistedAtDestination = await withCompanyContext(transaction, destination.id, () =>
      FinancialEntry.findByPk(toEntry.id, { transaction })
    );
    assert.ok(persistedAtDestination, 'a perna de entrada precisa estar visível sob o RLS da empresa de destino');
    assert.equal(persistedAtDestination.companyId, destination.id);

    // E NÃO é visível na origem — RLS real, não filtro de aplicação.
    const notVisibleAtOrigin = await FinancialEntry.findByPk(toEntry.id, { transaction });
    assert.equal(notVisibleAtOrigin, null, 'a perna de entrada não pode ser visível sob o RLS da empresa de origem');

    // Transferir para a própria empresa não faz sentido e é recusado.
    await assert.rejects(
      () =>
        intercompanyTransfersService.createIntercompanyTransfer(
          { groupId: tenant.groupId, companyId: tenant.companyId, toCompanyId: tenant.companyId, amount: 10 },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_INTERCOMPANY_SAME_COMPANY'); return true; }
    );

    const reconciled = await intercompanyTransfersService.reconcileIntercompanyTransfer(transfer.id, tenant.userId, transaction);
    assert.equal(reconciled.status, 'RECONCILED');
    assert.ok(reconciled.reconciledAt);

    await assert.rejects(
      () => intercompanyTransfersService.reconcileIntercompanyTransfer(transfer.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_INTERCOMPANY_ALREADY_RECONCILED'); return true; }
    );
  });
});

// ---------------------------------------------------------------------------------------
// M4-19 — Fechamento mensal com bloqueio de período
// ---------------------------------------------------------------------------------------

test('M4-19 fechar período bloqueia lançamento naquele mês; reabrir exige motivo e libera de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    // Mês no futuro distante: fechá-lo não interfere na criação de lançamentos "de hoje" (a
    // checagem também olha o mês de criação) nem em nada já existente no banco de homologação.
    const referenceMonth = '2031-07';
    const dueInsideClosedMonth = '2031-07-15T00:00:00.000Z';
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 640 };

    // Antes de fechar, o mês aceita lançamento normalmente.
    const before = await financialEntriesService.createFinancialEntry(
      { ...base, description: `M4-19 antes do fechamento ${suffix}`, dueAt: dueInsideClosedMonth },
      tenant.userId,
      transaction
    );
    assert.equal(before.status, 'PENDING');

    const closure = await periodClosuresService.closePeriod(
      { groupId: tenant.groupId, companyId: tenant.companyId, referenceMonth },
      tenant.userId,
      transaction
    );
    assert.equal(closure.status, 'CLOSED');
    assert.equal(closure.closedByUserId, tenant.userId);
    assert.ok(closure.closedAt);

    // Criar lançamento com vencimento no mês fechado: bloqueado.
    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          { ...base, description: `M4-19 bloqueado ${suffix}`, dueAt: dueInsideClosedMonth },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'FINANCE_PERIOD_CLOSED');
        assert.equal(err.details.referenceMonth, referenceMonth);
        return true;
      }
    );

    // Editar lançamento existente daquele mês: também bloqueado.
    await assert.rejects(
      () => financialEntriesService.updateFinancialEntry(before.id, { description: 'tentativa de editar mês fechado' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PERIOD_CLOSED'); return true; }
    );

    // Um mês vizinho, que não foi fechado, continua livre.
    const neighbour = await financialEntriesService.createFinancialEntry(
      { ...base, description: `M4-19 mes aberto ${suffix}`, dueAt: '2031-08-15T00:00:00.000Z' },
      tenant.userId,
      transaction
    );
    assert.equal(neighbour.status, 'PENDING');

    // Fechar duas vezes o mesmo mês não faz sentido.
    await assert.rejects(
      () => periodClosuresService.closePeriod({ groupId: tenant.groupId, companyId: tenant.companyId, referenceMonth }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PERIOD_ALREADY_CLOSED'); return true; }
    );

    // Reabrir SEM motivo: recusado.
    await assert.rejects(
      () => periodClosuresService.reopenPeriod({ companyId: tenant.companyId, referenceMonth }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PERIOD_REOPEN_REASON_REQUIRED'); return true; }
    );
    await assert.rejects(
      () => periodClosuresService.reopenPeriod({ companyId: tenant.companyId, referenceMonth, reason: '   ' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_PERIOD_REOPEN_REASON_REQUIRED'); return true; }
    );

    // Reabrir COM motivo: libera e deixa rastro de quem/por quê.
    const reopened = await periodClosuresService.reopenPeriod(
      { companyId: tenant.companyId, referenceMonth, reason: 'Nota fiscal do fornecedor chegou atrasada.' },
      tenant.userId,
      transaction
    );
    assert.equal(reopened.status, 'OPEN');
    assert.equal(reopened.reopenReason, 'Nota fiscal do fornecedor chegou atrasada.');
    assert.equal(reopened.reopenedByUserId, tenant.userId);
    assert.ok(reopened.reopenedAt);

    const afterReopen = await financialEntriesService.createFinancialEntry(
      { ...base, description: `M4-19 depois da reabertura ${suffix}`, dueAt: dueInsideClosedMonth },
      tenant.userId,
      transaction
    );
    assert.equal(afterReopen.status, 'PENDING');
  });
});

// ---------------------------------------------------------------------------------------
// M4-20 — Relatório semanal de saúde financeira
// ---------------------------------------------------------------------------------------

test('M4-20 getWeeklyHealthReport bate com a soma manual dos lançamentos criados no teste', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const base = { groupId: tenant.groupId, companyId: tenant.companyId };
    const now = new Date();
    const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // O banco de homologação é compartilhado e já tem lançamentos: comparamos o DELTA do
    // relatório (antes x depois), que é o que este teste de fato controla.
    const beforeReport = await financialHealthReportService.getWeeklyHealthReport(transaction, { now });

    await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'DEBIT', nature: 'PAYABLE', amount: 1000, dueAt: inThreeDays, description: `M4-20 pagar 7d ${suffix}` },
      tenant.userId,
      transaction
    );
    await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'DEBIT', nature: 'PAYABLE', amount: 250.5, dueAt: threeDaysAgo, description: `M4-20 pagar vencido ${suffix}` },
      tenant.userId,
      transaction
    );
    await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 4000, dueAt: inThirtyDays, description: `M4-20 receber 30d ${suffix}` },
      tenant.userId,
      transaction
    );
    await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 120, dueAt: threeDaysAgo, description: `M4-20 receber vencido ${suffix}` },
      tenant.userId,
      transaction
    );
    // Caução: dinheiro de terceiro — não pode contaminar nenhum número de resultado próprio.
    await financialEntriesService.createFinancialEntry(
      {
        ...base,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: 9999,
        dueAt: inThreeDays,
        description: `M4-20 caucao ${suffix}`,
        isThirdPartyFunds: true,
        thirdPartyReference: `Caução contrato ${suffix}`,
      },
      tenant.userId,
      transaction
    );
    // Já liquidado: não é mais "a pagar".
    const settled = await financialEntriesService.createFinancialEntry(
      { ...base, entryType: 'DEBIT', nature: 'PAYABLE', amount: 777, dueAt: inThreeDays, description: `M4-20 ja pago ${suffix}` },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(settled.id, tenant.userId, transaction);

    const afterReport = await financialHealthReportService.getWeeklyHealthReport(transaction, { now });
    const round2 = (v) => Math.round(v * 100) / 100;
    const delta = (path) => round2(path(afterReport) - path(beforeReport));

    // Somas manuais: a pagar = 1000 + 250,50 ; a receber = 4000 + 120 (caução fora, pago fora).
    assert.equal(delta((r) => r.payablePending.total), 1250.5);
    assert.equal(delta((r) => r.receivablePending.total), 4120);
    assert.equal(delta((r) => r.payablePending.count), 2);
    assert.equal(delta((r) => r.receivablePending.count), 2);

    // Saldo líquido projetado = a receber próprio − a pagar.
    assert.equal(delta((r) => r.projectedNetBalance), round2(4120 - 1250.5));
    assert.equal(
      afterReport.projectedNetBalance,
      round2(afterReport.receivablePending.total - afterReport.payablePending.total),
      'o saldo projetado precisa ser exatamente a receber − a pagar'
    );

    // Vencidos: 250,50 a pagar + 120 a receber.
    assert.equal(delta((r) => r.overdue.payable.total), 250.5);
    assert.equal(delta((r) => r.overdue.receivable.total), 120);
    assert.equal(delta((r) => r.overdue.total), 370.5);

    // Janela dos próximos 7 dias: só o de 1000 (o de 4000 vence em 30 dias).
    assert.equal(delta((r) => r.dueNextSevenDays.payable.total), 1000);
    assert.equal(delta((r) => r.dueNextSevenDays.receivable.total), 0);

    // Dinheiro de terceiro aparece segregado, e só ali.
    assert.equal(delta((r) => r.thirdPartyFunds.total), 9999);
    assert.equal(delta((r) => r.thirdPartyFunds.count), 1);
  });
});

// ---------------------------------------------------------------------------------------
// M4-25 — Restore e replay financeiro sem duplicidade
// ---------------------------------------------------------------------------------------
//
// ESCOPO — LEIA ANTES DE INTERPRETAR ESTE TESTE:
// O "restore de banco de dados" em si (snapshot, point-in-time recovery, restauração do dump)
// é responsabilidade de INFRAESTRUTURA — Easypanel/rotina de backup do Postgres — e não é
// código deste repositório; nada aqui pretende testar isso.
//
// O que este teste cobre é a garantia de nível de APLICAÇÃO que torna um restore seguro: depois
// de restaurar e reprocessar (replay) eventos/importações que já haviam sido processados,
// NENHUM reprocessamento pode duplicar dinheiro. Ou seja: o mesmo evento processado duas vezes
// produz exatamente um FinancialEntry e exatamente uma liquidação — a segunda passagem é
// rejeitada pela chave de idempotência (FIN-004), não silenciosamente aplicada de novo.

test('M4-25 replay do mesmo evento em transações distintas não duplica FinancialEntry (idempotencyKey)', async () => {
  const suffix = uniqueSuffix();
  const idempotencyKey = `replay-m425-${suffix}`;
  const payload = {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    entryType: 'DEBIT',
    nature: 'PAYABLE',
    amount: 1875.25,
    description: `HOMO QA M4-25 replay ${suffix}`,
    idempotencyKey,
  };

  // 1ª passagem — transação COMMITADA (simula o processamento original, antes do incidente).
  const first = await withCommittedTenantTransaction(tenant, (t) =>
    financialEntriesService.createFinancialEntry(payload, tenant.userId, t)
  );
  assert.equal(first.idempotencyKey, idempotencyKey);

  try {
    // 2ª passagem — transação NOVA, mesmo evento (simula o replay pós-restore).
    await assert.rejects(
      () => withCommittedTenantTransaction(tenant, (t) => financialEntriesService.createFinancialEntry(payload, tenant.userId, t)),
      (err) => { assert.equal(err.code, 'FINANCE_DUPLICATE_PAYMENT'); return true; },
      'reprocessar o mesmo evento não pode criar um segundo lançamento'
    );

    // 3ª passagem — mais uma vez, para garantir que a rejeição é estável (não é um "uma vez só").
    await assert.rejects(
      () => withCommittedTenantTransaction(tenant, (t) => financialEntriesService.createFinancialEntry(payload, tenant.userId, t)),
      (err) => { assert.equal(err.code, 'FINANCE_DUPLICATE_PAYMENT'); return true; }
    );

    // Prova definitiva: existe UM único lançamento com essa chave no banco.
    const count = await withCommittedTenantTransaction(tenant, (t) =>
      FinancialEntry.count({ where: { idempotencyKey }, transaction: t })
    );
    assert.equal(count, 1, 'o replay não pode ter duplicado dinheiro no ledger');

    // O evento de domínio correspondente também é idempotente: republicar o mesmo evento
    // (mesma idempotencyKey no outbox) é impedido pela constraint única — um consumidor que
    // reprocessar o outbox não vê o mesmo fato duas vezes.
    const outboxCount = await withCommittedTenantTransaction(tenant, (t) =>
      OutboxEvent.count({ where: { idempotencyKey: `finance.entry.created:${first.id}` }, transaction: t })
    );
    assert.equal(outboxCount, 1);

    await assert.rejects(
      () =>
        withCommittedTenantTransaction(tenant, async (t) => {
          const entry = await FinancialEntry.findByPk(first.id, { transaction: t });
          return publishFinancialEntryCreated(entry, t);
        }),
      (err) => {
        assert.equal(err.name, 'SequelizeUniqueConstraintError', `esperado erro de unicidade no outbox, veio: ${err.name}`);
        return true;
      },
      'republicar o mesmo evento de domínio não pode gerar uma segunda linha no outbox'
    );

    const outboxCountAfter = await withCommittedTenantTransaction(tenant, (t) =>
      OutboxEvent.count({ where: { idempotencyKey: `finance.entry.created:${first.id}` }, transaction: t })
    );
    assert.equal(outboxCountAfter, 1);
  } finally {
    // O ledger é imutável (FIN-003) — não apagamos o lançamento. Cancelamos para deixar claro,
    // em homologação, que é dado de teste e não uma obrigação real a pagar.
    await withCommittedTenantTransaction(tenant, async (t) => {
      const entry = await FinancialEntry.findByPk(first.id, { transaction: t });
      if (entry && entry.status === 'PENDING') {
        entry.status = 'CANCELLED';
        await entry.save({ transaction: t });
      }
    });
  }
});

test('M4-25 replay de liquidação não paga duas vezes o mesmo lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 640,
        description: `M4-25 settle replay ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED');
    const settledAt = settled.settledAt;

    // Replay da mesma liquidação: recusada, e o carimbo original não é sobrescrito.
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS'); return true; }
    );

    const reread = await financialEntriesService.getFinancialEntry(entry.id, transaction);
    assert.equal(reread.status, 'SETTLED');
    assert.equal(new Date(reread.settledAt).getTime(), new Date(settledAt).getTime(), 'a data de liquidação original não pode ser reescrita');

    // Um único evento de liquidação no outbox — o consumidor não vê dois pagamentos.
    const settledEvents = await OutboxEvent.count({
      where: { idempotencyKey: `finance.entry.settled:${entry.id}` },
      transaction,
    });
    assert.equal(settledEvents, 1);
  });
});
