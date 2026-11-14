'use strict';

/**
 * Fixtures controladas do drill de restore FINANCEIRO (Marco 4 — Caderno §21 "Restore/replay
 * financeiro validado", Guia §1.17, M4-25 "Restore e replay financeiro sem duplicidade").
 *
 * Roda num processo filho com DATABASE_URL = banco de ORIGEM do drill (role de runtime, sem
 * BYPASSRLS, RLS FORCE) e UPLOADS_DIR = storage de origem. Tudo pelos SERVIÇOS REAIS, com COMMIT
 * (é a origem que vai para o backup):
 *   A) recebível de R$ 0,30 com duas baixas parciais (0,10 e 0,20): saldo 0,20 → 0,00, pai SETTLED;
 *   B) pagável com intenção de pagamento criada por um e aprovada por OUTRO, enviada ao banco
 *      sandbox e confirmada pelo callback com HMAC (mesmo código do webhook público);
 *   C) extrato CSV importado da mesma conta + conciliação lançamento × linha do extrato;
 *   D) caução (dinheiro de terceiros) recebida, com contrato e titular;
 *   E) repasse ao proprietário: criado, aprovado por outra pessoa, pago (comprovante + ApprovalRequest);
 *   F) comissão pelo Motor de Regras (rule_version_id), 2 parcelas, 1ª paga após recebimento de 50%;
 *   G) transferência entre empresas do mesmo grupo aprovada por outra pessoa (dois lados vinculados);
 *   H) período 2025-06 fechado (REVIEW → CLOSED por outra pessoa) com um recebível dentro;
 *   I) caso de anomalia HIGH aberto;
 *   J) segundo tenant (grupo B) com lançamento próprio, para o teste de isolamento pós-restore.
 *
 * Proteção: recusa rodar fora de um banco local "drill_*" (drillGuard).
 * Saída: JSON com os ids e valores esperados, em --out.
 */

const fs = require('fs');
const crypto = require('crypto');
const { assertDrillDatabase } = require('./drillGuard');

assertDrillDatabase(process.env.DATABASE_URL, 'seedFinanceFixtures');

const outArg = process.argv.indexOf('--out');
const OUT = outArg !== -1 ? process.argv[outArg + 1] : null;

const { sequelize, Group, Company, User, BankAccount, CostCenter, ResultCenter, Person, Property, FinancialEntry, PaymentIntent } = require('../../src/models');
const financialEntries = require('../../src/modules/finance/application/services/financial-entry.service');
const settlementEvidence = require('../../src/modules/finance/application/services/settlement-evidence.service');
const receiptService = require('../../src/modules/finance/application/services/receipt.service');
const paymentIntents = require('../../src/modules/finance/application/services/payment.service');
const bankPayments = require('../../src/modules/finance/application/services/bank-submission.service');
const bankTransactions = require('../../src/modules/finance/application/services/bank-transactions.service');
const reconciliation = require('../../src/modules/finance/application/services/reconciliation.service');
const approvals = require('../../src/modules/finance/application/services/approvals.service');
const ownerRepasses = require('../../src/modules/finance/application/services/owner-repasses.service');
const commissions = require('../../src/modules/finance/application/services/commission.service');
const intercompany = require('../../src/modules/finance/application/services/intercompany-transfers.service');
const periodClosures = require('../../src/modules/finance/application/services/closing.service');
const anomalyCases = require('../../src/modules/finance/application/services/anomaly-cases.service');
const settingsService = require('../../src/features/settings/settings.service');
const filesService = require('../../src/features/files/files.service');
const financeController = require('../../src/modules/finance/presentation/http/finance.controller');

const STAMP = Date.now();
const CLOSED_MONTH = '2025-06';

async function inTenant(tenant, fn) {
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SELECT set_config(\'app.company_id\', :c, true)', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SELECT set_config(\'app.user_id\', :u, true)', { replacements: { u: tenant.userId }, transaction: t });
    return fn(t);
  });
}

const W = (tenant, fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });
const newUser = (label) => User.create({ name: `DRILL FIN ${label}`, email: `drill-fin-${label}-${STAMP}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
const todayBR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

async function evidenceFile(tenant, t, label) {
  const bytes = Buffer.from(`%PDF-1.4\n% Drill restore financeiro — ${label}\n${crypto.randomBytes(1024).toString('base64')}\n%%EOF\n`);
  const file = await filesService.uploadFile(W(tenant, { fileName: `drill-fin-${label}.pdf`, mimeType: 'application/pdf', contentBase64: bytes.toString('base64'), category: 'generic' }), tenant.userId, t);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// Baixa formal de um PAYABLE: comprovante anexado → ApprovalRequest aprovada por OUTRA pessoa → baixa manual.
async function settlePayableFormally(tenant, t, entryId, approverId, ids) {
  const { file, sha256 } = await evidenceFile(tenant, t, `comprovante-${entryId.slice(0, 8)}`);
  ids.files[file.id] = sha256;
  const manualSettlement = { evidenceFileId: file.id, reason: 'Drill: pagamento feito fora da integração bancária — comprovante anexado.' };
  await settlementEvidence.attachSettlementEvidence(entryId, manualSettlement, tenant.userId, t);
  const request = await approvals.createApprovalRequest(W(tenant, { relatedEntityType: 'FinancialEntry', relatedEntityId: entryId, riskLevel: 'LOW' }), tenant.userId, t);
  await approvals.decideApprovalStep(request.id, { decision: 'APPROVED' }, approverId, t);
  ids.approvalRequestIds.push(request.id);
  return receiptService.settleFinancialEntry(entryId, tenant.userId, t, { manualSettlement });
}

async function seedReceivable030(tenant, t, ids) {
  const rc = await ResultCenter.create(W(tenant, { code: `RC-DRILL-${STAMP}`, name: 'DRILL Centro de resultado' }), { transaction: t });
  ids.resultCenterId = rc.id;
  const parent = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '0.30', resultCenterId: rc.id, description: 'DRILL recebível fictício de R$ 0,30 (duas baixas)', dueAt: new Date(Date.now() + 5 * 86400000) }),
    tenant.userId, t
  );
  const steps = [];
  for (const [amount, key] of [['0.10', `drill-rec030-b1-${STAMP}`], ['0.20', `drill-rec030-b2-${STAMP}`]]) {
    // Aceita os dois jeitos: com idempotencyKey (correção do FIN-004 em andamento) ou sem.
    const res = await receiptService.settleFinancialEntryPartial(parent.id, amount, tenant.userId, t, { idempotencyKey: key });
    steps.push({ amount, idempotencyKey: key, settlementEntryId: res.settlement.id, remainingAmount: res.remainingAmount, parentStatus: res.original.status });
  }
  ids.receivable030 = { parentId: parent.id, amount: '0.30', steps };
}

async function seedPaymentFlow(tenant, t, ids, approverId) {
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  await settingsService.upsertSetting('finance.payment_provider', 'sandbox', tenant, tenant.userId, t);
  await settingsService.upsertSetting('finance.bank_payment_webhook_secret', webhookSecret, tenant, tenant.userId, t);
  const bank = await BankAccount.create(W(tenant, { bankCode: '748', agency: '0001', accountNumber: `DRILL-${STAMP}`, pixKey: `drill-fin-${STAMP}@nayaraone.dev`, status: 'ACTIVE' }), { transaction: t });
  const cc = await CostCenter.create(W(tenant, { code: `CC-DRILL-${STAMP}`, name: 'DRILL Centro de custo' }), { transaction: t });
  ids.bankAccountId = bank.id;
  ids.costCenterId = cc.id;
  const entry = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'DEBIT', nature: 'PAYABLE', amount: '1234.56', description: 'DRILL pagamento ao fornecedor (intenção aprovada)', costCenterId: cc.id, bankAccountId: bank.id, dueAt: new Date(Date.now() + 2 * 86400000), idempotencyKey: `drill-payable-${STAMP}` }),
    tenant.userId, t
  );
  const intent = await paymentIntents.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
  await paymentIntents.approvePaymentIntent(intent.id, approverId, t);
  const submitted = await bankPayments.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t);
  const externalSubmissionId = (await PaymentIntent.findByPk(intent.id, { transaction: t })).externalSubmissionId || submitted.externalSubmissionId;
  const body = { externalSubmissionId, status: 'CONFIRMED' };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  ids.payment = { financialEntryId: entry.id, paymentIntentId: intent.id, externalSubmissionId, idempotencyKey: `drill-payable-${STAMP}`, webhookBody: body, webhookSignature: signature };
  return { entry, bank };
}

async function confirmPaymentByWebhook(ids) {
  const { webhookBody: body, webhookSignature: signature } = ids.payment;
  const rawBody = Buffer.from(JSON.stringify(body));
  const result = await sequelize.transaction((t) => financeController.processBankPaymentWebhook({ body, rawBody, headers: { 'x-webhook-signature': signature } }, t));
  if (!result.processed) throw new Error(`callback do banco não processado: ${JSON.stringify(result)}`);
  ids.payment.webhookResult = result;
}

async function seedStatementAndReconciliation(tenant, t, ids) {
  const csvText = `externalTransactionId,transactionDate,description,amount\nDRILL-STMT-${STAMP},${todayBR()},PIX enviado DRILL,-1234.56\n`;
  const imported = await bankTransactions.importBankStatement(W(tenant, { bankAccountId: ids.bankAccountId, csvText }), tenant.userId, t);
  if (imported.imported.length !== 1) throw new Error(`importação do extrato: esperado 1, veio ${imported.imported.length}`);
  const bankTx = imported.imported[0];
  const rec = await reconciliation.matchReconciliation(W(tenant, { financialEntryId: ids.payment.financialEntryId, bankTransactionId: bankTx.id }), tenant.userId, t);
  ids.statement = { csvText, bankTransactionId: bankTx.id, reconciliationId: rec.id };
}

async function seedDeposit(tenant, t, ids) {
  const { Contract, ContractParty } = require('../../src/models');
  const contract = await Contract.create(W(tenant, { contractType: 'LEASE', contractNumber: `DRILL-CAUCAO-${STAMP}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const holder = await Person.create(W(tenant, { personType: 'PF', legalName: 'DRILL Locatário titular da caução', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  await ContractParty.create(W(tenant, { contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }), { transaction: t });
  const deposit = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '2000.00', description: 'DRILL caução recebida (dinheiro de terceiros)', resultCenterId: ids.resultCenterId, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${contract.id}`, thirdPartyHolderPersonId: holder.id }),
    tenant.userId, t
  );
  await receiptService.settleFinancialEntry(deposit.id, tenant.userId, t);
  ids.deposit = { entryId: deposit.id, contractId: contract.id, holderPersonId: holder.id };
}

async function seedRepasse(tenant, t, ids, checkerId) {
  const owner = await Person.create(W(tenant, { personType: 'PF', legalName: 'DRILL Proprietário', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const property = await Property.create(W(tenant, { title: 'DRILL Imóvel do repasse', internalCode: `DRILL-REP-${STAMP}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const rent = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '3000.00', resultCenterId: ids.resultCenterId, description: 'DRILL aluguel recebido (origem do repasse)' }),
    tenant.userId, t
  );
  await receiptService.settleFinancialEntry(rent.id, tenant.userId, t);
  const repasse = await ownerRepasses.createOwnerRepasse(
    W(tenant, { propertyId: property.id, ownerPersonId: owner.id, bankAccountId: ids.bankAccountId, sourceEntryIds: [rent.id], grossAmount: 1000, deductionsAmount: 100, deductionsReason: 'Taxa de administração', referenceMonth: todayBR().slice(0, 7) }),
    tenant.userId, t
  );
  const { financialEntry } = await ownerRepasses.approveOwnerRepasse(repasse.id, { costCenterId: ids.costCenterId }, checkerId, t);
  await settlePayableFormally(tenant, t, financialEntry.id, checkerId, ids);
  const paid = await ownerRepasses.payOwnerRepasse(repasse.id, tenant.userId, t);
  ids.repasse = { id: repasse.id, status: paid.status, payableEntryId: financialEntry.id, sourceEntryId: rent.id };
}

async function seedCommission(tenant, t, ids, approverId) {
  const version = await commissions.publishCommissionRuleVersion(W(tenant, { componentPercentages: { BROKER: 10 } }), tenant.userId, t);
  const source = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '1000.00', resultCenterId: ids.resultCenterId, description: 'DRILL venda (fato gerador da comissão)' }),
    tenant.userId, t
  );
  const { commission, installments } = await commissions.createCommission(
    W(tenant, { beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', installmentsCount: 2, idempotencyKey: `drill-commission-${STAMP}` }),
    tenant.userId, t
  );
  await receiptService.settleFinancialEntryPartial(source.id, '500.00', tenant.userId, t, { idempotencyKey: `drill-commission-src-${STAMP}` });
  const payable = await financialEntries.createFinancialEntry(
    W(tenant, { entryType: 'DEBIT', nature: 'PAYABLE', amount: '50.00', costCenterId: ids.costCenterId, description: 'DRILL pagamento da 1ª parcela da comissão' }),
    tenant.userId, t
  );
  await settlePayableFormally(tenant, t, payable.id, approverId, ids);
  const paid = await commissions.markInstallmentPaid(installments[0].id, payable.id, tenant.userId, t);
  ids.commission = { id: commission.id, ruleVersionId: version.id, sourceEntryId: source.id, installmentIds: installments.map((i) => i.id), paidInstallmentStatus: paid.status };
}

async function seedIntercompany(tenant, ids, checkerId) {
  const destination = await inTenant(tenant, (t) => Company.create({ groupId: tenant.groupId, name: `DRILL Empresa destino ${STAMP}`, status: 'ACTIVE' }, { transaction: t }));
  const toAccount = await inTenant({ ...tenant, companyId: destination.id }, (t) => BankAccount.create({ groupId: tenant.groupId, companyId: destination.id, bankCode: '001', agency: '0002', accountNumber: `DRILL-IC-${STAMP}`, status: 'ACTIVE' }, { transaction: t }));
  return inTenant(tenant, async (t) => {
    const { file, sha256 } = await evidenceFile(tenant, t, 'intercompany');
    ids.files[file.id] = sha256;
    const { transfer } = await intercompany.createIntercompanyTransfer(
      W(tenant, { toCompanyId: destination.id, amount: 750.25, reason: 'DRILL aporte de caixa entre empresas do grupo', evidenceFileId: file.id, fromBankAccountId: ids.bankAccountId, toBankAccountId: toAccount.id }),
      tenant.userId, t
    );
    const approved = await intercompany.approveIntercompanyTransfer(transfer.id, {}, checkerId, t);
    ids.intercompany = { id: transfer.id, toCompanyId: destination.id, fromEntryId: approved.fromEntry.id, toEntryId: approved.toEntry.id, status: approved.transfer.status };
  });
}

async function seedClosedPeriod(tenant, ids, approverId) {
  await inTenant(tenant, async (t) => {
    const inside = await financialEntries.createFinancialEntry(
      W(tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '200.00', resultCenterId: ids.resultCenterId, description: 'DRILL recebível dentro do mês fechado', competenceMonth: CLOSED_MONTH, dueAt: `${CLOSED_MONTH}-12T15:00:00.000Z` }),
      tenant.userId, t
    );
    for (const checkType of ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES']) {
      await periodClosures.confirmPeriodCheck(W(tenant, { referenceMonth: CLOSED_MONTH, checkType, note: `Drill: conferência ${checkType}` }), tenant.userId, t);
    }
    await periodClosures.closePeriod(W(tenant, { referenceMonth: CLOSED_MONTH }), tenant.userId, t);
    ids.closedPeriod = { referenceMonth: CLOSED_MONTH, insideEntryId: inside.id };
  });
  await inTenant({ ...tenant, userId: approverId }, async (t) => {
    const closed = await periodClosures.approvePeriodClosure(W(tenant, { referenceMonth: CLOSED_MONTH }), approverId, t);
    ids.closedPeriod.id = closed.id;
    ids.closedPeriod.status = closed.status;
  });
}

async function seedTenantB(tenantA) {
  const group = await Group.create({ name: `DRILL FIN Grupo B ${STAMP}` });
  const company = await sequelize.transaction(async (t) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: group.id }, transaction: t });
    return Company.create({ groupId: group.id, name: 'DRILL FIN Empresa B' }, { transaction: t });
  });
  const tenantB = { groupId: group.id, companyId: company.id, userId: tenantA.userId };
  const entryId = await inTenant(tenantB, async (t) => {
    const rc = await ResultCenter.create(W(tenantB, { code: `RC-DRILL-B-${STAMP}`, name: 'DRILL B centro de resultado' }), { transaction: t });
    const e = await financialEntries.createFinancialEntry(W(tenantB, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '999.99', resultCenterId: rc.id, description: 'DRILL lançamento do tenant B' }), tenantB.userId, t);
    return e.id;
  });
  return { ...tenantB, entryId };
}

async function main() {
  if (!OUT) throw new Error('Uso: node scripts/restoreDrill/seedFinanceFixtures.js --out <arquivo.json>');
  const group = await Group.findOne({ where: { name: 'Nayara One — Grupo Dev' } });
  if (!group) throw new Error('Tenant de seed não encontrado (rode seed-dev antes).');
  const company = await sequelize.transaction(async (t) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: group.id }, transaction: t });
    return Company.findOne({ where: { groupId: group.id, name: 'Nayara One — Empresa Dev' }, transaction: t });
  });
  const admin = await User.findOne({ where: { email: 'admin@nayaraone.dev' } });
  const tenantA = { groupId: group.id, companyId: company.id, userId: admin.id };
  const approver = await newUser('aprovador');
  const checker = await newUser('conferente');
  const ids = { files: {}, approvalRequestIds: [] };

  await inTenant(tenantA, (t) => seedReceivable030(tenantA, t, ids));
  await inTenant(tenantA, (t) => seedPaymentFlow(tenantA, t, ids, approver.id));
  await confirmPaymentByWebhook(ids);
  await inTenant(tenantA, (t) => seedStatementAndReconciliation(tenantA, t, ids));
  await inTenant(tenantA, (t) => seedDeposit(tenantA, t, ids));
  await inTenant(tenantA, (t) => seedRepasse(tenantA, t, ids, checker.id));
  await inTenant(tenantA, (t) => seedCommission(tenantA, t, ids, approver.id));
  await seedIntercompany(tenantA, ids, checker.id);
  await seedClosedPeriod(tenantA, ids, approver.id);
  ids.anomalyCaseId = await inTenant(tenantA, async (t) => (await anomalyCases.createAnomalyCase(
    W(tenantA, { caseType: 'AMOUNT_OUTLIER', riskLevel: 'HIGH', relatedEntityType: 'FinancialEntry', relatedEntityId: ids.payment.financialEntryId, reason: 'Drill: valor fora do padrão para revisão.' }),
    tenantA.userId, t
  )).id);
  const tenantB = await seedTenantB(tenantA);

  const entries = await inTenant(tenantA, (t) => FinancialEntry.count({ transaction: t }));
  fs.writeFileSync(OUT, JSON.stringify({ tenantA: { ...tenantA, ...ids, userIds: [admin.id, approver.id, checker.id] }, tenantB }, null, 2));
  console.log(
    `Fixtures financeiras criadas: recebível 0,30 (${ids.receivable30Summary || ids.receivable030.steps.map((s) => `${s.amount}→saldo ${s.remainingAmount}`).join(', ')}), ` +
    `intenção ${ids.payment.paymentIntentId} confirmada pelo callback, conciliação ${ids.statement.reconciliationId}, caução ${ids.deposit.entryId}, ` +
    `repasse ${ids.repasse.status}, comissão (versão ${ids.commission.ruleVersionId}, parcela 1 ${ids.commission.paidInstallmentStatus}), ` +
    `intercompany ${ids.intercompany.status}, período ${CLOSED_MONTH} ${ids.closedPeriod.status}, anomalia ${ids.anomalyCaseId}; ` +
    `${entries} lançamentos no tenant A; tenant B ${tenantB.companyId}.`
  );
  await sequelize.close();
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await sequelize.close().catch(() => {});
  process.exitCode = 1;
});
