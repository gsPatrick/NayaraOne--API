'use strict';

// Marcos 4/5 — trilha de auditoria com ANTES/DEPOIS (padrão da página de entrega atualizado em
// 19/10/2026; mesmo trabalho feito no Marco 7 em e7f96fb) + correções da reconferência ao vivo
// M45-RECONF (F2 "Consultar banco", F3 histórico da regra de comissão, F8 competência BR).
// Regra: criação grava afterJson; transição/atualização/exclusão grava beforeJson E afterJson.
// Tudo roda dentro de transação desfeita no fim (nada fica no banco).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const commissionsService = require('../src/features/finance/commissions.service');
const costCentersService = require('../src/features/finance/costCenters.service');
const resultCentersService = require('../src/features/finance/resultCenters.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');
const financeExportService = require('../src/features/finance/financeExport.service');
const contractsService = require('../src/features/legal/contracts.service');
const closeoutService = require('../src/features/billing/closeout.service');
const { formatCompetenceBR, formatMoneyBR } = require('../src/utils/formatBR');
const { AuditLog, PaymentIntent, BankPaymentProviderRouting } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

const withTenant = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function auditRow(action, entityId, transaction) {
  const row = await AuditLog.findOne({ where: { action, entityId }, order: [['occurred_at', 'DESC']], transaction });
  assert.ok(row, `linha de audit_log ${action} para ${entityId} deveria existir`);
  return row;
}

async function expectTransition(action, entityId, transaction) {
  const row = await auditRow(action, entityId, transaction);
  assert.ok(row.beforeJson && Object.keys(row.beforeJson).length > 0, `${action}: beforeJson obrigatório`);
  assert.ok(row.afterJson && Object.keys(row.afterJson).length > 0, `${action}: afterJson obrigatório`);
  return row;
}

async function payableEntry(transaction, amount = 77.7) {
  const suffix = uniqueSuffix();
  const cc = await costCentersService.createCostCenter(withTenant({ code: `M45A-${suffix}`, name: `M45 audit ${suffix}` }), tenant.userId, transaction);
  const account = await bankAccountsService.createBankAccount(withTenant({ bankCode: '001', agency: '1', accountNumber: `M45A-${suffix}` }), tenant.userId, transaction);
  account.status = 'ACTIVE';
  await account.save({ transaction });
  const entry = await financialEntriesService.createFinancialEntry(
    withTenant({
      bankAccountId: account.id, costCenterId: cc.id, entryType: 'DEBIT', nature: 'PAYABLE', amount,
      description: `M45 audit pagar ${suffix}`, dueAt: new Date(), idempotencyKey: `m45-audit-${suffix}`,
    }),
    tenant.userId, transaction
  );
  return { entry, account };
}

test('regra de comissão: publicar grava antes (versão anterior) e depois; histórico lista as versões', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const v1 = await commissionsService.publishCommissionRuleVersion(withTenant({ componentPercentages: { BROKER: 5 } }), tenant.userId, transaction);
    const v2 = await commissionsService.publishCommissionRuleVersion(withTenant({ componentPercentages: { BROKER: 6, MANAGER: 1 } }), tenant.userId, transaction);
    const row = await expectTransition('finance.commission_rule.publish', v2.id, transaction);
    assert.equal(row.beforeJson.versionNumber, v1.versionNumber);
    assert.equal(row.beforeJson.components.BROKER, 5);
    assert.equal(row.afterJson.components.BROKER, 6);

    const versions = await commissionsService.listCommissionRuleVersions(tenant.groupId, tenant.companyId, transaction);
    assert.ok(versions.length >= 2);
    assert.equal(versions[0].versionNumber, v2.versionNumber);
    assert.equal(versions[0].current, true);
    assert.equal(versions[1].versionNumber, v1.versionNumber);
    assert.equal(versions[1].current, false);
    assert.ok(versions[1].effectiveUntil, 'versão anterior tem fim de vigência');
    assert.ok(versions[0].publishedByName && !/^[0-9a-f-]{36}$/.test(versions[0].publishedByName), 'quem publicou aparece por nome');
  });
});

test('exclusões (centro de custo, centro de resultado, conta bancária) gravam antes e depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const cc = await costCentersService.createCostCenter(withTenant({ code: `M45D-${suffix}`, name: `M45 del ${suffix}` }), tenant.userId, transaction);
    await costCentersService.deleteCostCenter(cc.id, tenant.userId, transaction);
    const rowCc = await expectTransition('finance.cost_center.delete', cc.id, transaction);
    assert.ok(rowCc.afterJson.deletedAt);

    const rc = await resultCentersService.createResultCenter(withTenant({ code: `M45D-${suffix}`, name: `M45 del ${suffix}` }), tenant.userId, transaction);
    await resultCentersService.deleteResultCenter(rc.id, tenant.userId, transaction);
    await expectTransition('finance.result_center.delete', rc.id, transaction);

    const account = await bankAccountsService.createBankAccount(withTenant({ bankCode: '001', agency: '1', accountNumber: `M45D-${suffix}` }), tenant.userId, transaction);
    await bankAccountsService.deleteBankAccount(account.id, tenant.userId, transaction);
    await expectTransition('finance.bank_account.delete', account.id, transaction);
  });
});

test('conciliação e exportação gravam antes e depois; motivo com valor em reais', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, account } = await payableEntry(transaction, 77.7);
    const tx = await bankTransactionsService.createBankTransaction(
      withTenant({ bankAccountId: account.id, amount: -77.7, transactionDate: new Date(), description: 'M45 audit extrato' }),
      tenant.userId, transaction
    );
    const rec = await reconciliationService.matchReconciliation(withTenant({ financialEntryId: entry.id, bankTransactionId: tx.id }), tenant.userId, transaction);
    const row = await expectTransition('finance.reconciliation.match', rec.id, transaction);
    assert.equal(row.beforeJson.conciliado, false);
    assert.match(row.reason, /R\$ 77,70/);

    const exported = await financeExportService.exportFinancialEntries(
      { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, { status: 'PENDING' }, transaction, { maxRows: 100000 }
    );
    assert.ok(exported.sha256);
    const exp = await AuditLog.findOne({ where: { action: 'finance.entries.export' }, order: [['occurred_at', 'DESC']], transaction });
    assert.ok(exp.beforeJson && exp.afterJson);
  });
});

test('F2: "Consultar banco" acha a intenção mesmo sem roteamento gravado e muda a situação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await payableEntry(transaction, 12.34);
    const created = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    const intent = await PaymentIntent.findByPk(created.id, { transaction });
    intent.status = 'SUBMITTED';
    intent.paymentMethod = 'PIX';
    intent.externalSubmissionId = `sandbox-m45-audit-${uniqueSuffix()}`;
    intent.externalStatus = 'PENDING_EXTERNAL';
    intent.submittedAt = new Date();
    await intent.save({ transaction });

    const result = await bankPaymentsService.reconcilePaymentIntent(intent.id, { userId: tenant.userId }, transaction);
    assert.equal(result.outcome, 'CONFIRMED');
    assert.equal(result.intent.status, 'EXECUTED');
    const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId: intent.externalSubmissionId }, transaction });
    assert.ok(routing, 'roteamento recriado');
    await expectTransition('finance.payment_intent.confirm_bank_payment', intent.id, transaction);
  });
});

test('F1: encerramento sem pendência grava antes/depois; checagem devolve lista', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(withTenant({ contractType: 'LEASE_RESIDENTIAL' }), tenant.userId, transaction);
    const reasons = await closeoutService.checkCloseoutEligibility(contract.id, transaction);
    assert.ok(Array.isArray(reasons));
    assert.equal(reasons.length, 0);
    await closeoutService.closeoutContract(contract.id, tenant.userId, transaction);
    const row = await expectTransition('billing.closeout.completed', contract.id, transaction);
    assert.doesNotMatch(row.reason, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'motivo cita o número do contrato, não o UUID');
  });
});

test('F8: competência e valores em formato brasileiro nos textos gerados', () => {
  assert.equal(formatCompetenceBR('2026-09'), '09/2026');
  assert.equal(formatCompetenceBR('setembro'), 'setembro');
  assert.equal(formatMoneyBR(1234.5), 'R$ 1.234,50');
});

test('varredura do código: toda auditoria dos Marcos 4/5 grava depois; não-criação grava antes e depois', () => {
  const roots = ['src/features/finance', 'src/features/billing', 'src/features/legal', 'src/engines/jobs'].map((r) => path.join(__dirname, '..', r));
  const CREATION = /\.(create|generate|request|open|enroll|import|step|access|manual_collect)'$/;
  const problems = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      let idx = src.indexOf('registrarAuditoria(');
      while (idx !== -1) {
        let i = idx + 'registrarAuditoria('.length;
        let depth = 1;
        while (depth > 0 && i < src.length) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') depth -= 1;
          i += 1;
        }
        const block = src.slice(idx, i);
        const action = (/action:\s*('[^']+')/.exec(block) || [])[1];
        if (action && /^'(finance|billing|legal)\./.test(action)) {
          if (!block.includes('afterJson')) problems.push(`${name}: ${action} sem afterJson`);
          if (!CREATION.test(action) && !block.includes('beforeJson')) problems.push(`${name}: ${action} sem beforeJson`);
        }
        idx = src.indexOf('registrarAuditoria(', i);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(problems, []);
});
