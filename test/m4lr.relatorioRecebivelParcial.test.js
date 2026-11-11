'use strict';

// Caderno M4 §19 (relatório semanal de saúde), §13 ("relatório mostra saldo de terceiros separado do caixa livre") e §18.1
// (NAY explica fluxo de caixa). O caso real da homologação: o recebível de R$ 0,30, conferido ANTES, com BAIXA PARCIAL de
// 0,10, QUITADO (0,10 + 0,20) e ESTORNADO — o relatório, a NAY e o read model do BI (rm_finance_health) contam o mesmo
// número. Verificação independente 11/11/2026, sondas P6, P10, P12 e P13. Cada cenário numa empresa nova (números exatos).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { uniqueSuffix, withTenantTransaction, sequelize, createTestResultCenter, createTestCostCenter, createThirdPartyLink, settleFinancialEntryWithApproval } = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const entriesSvc = require('../src/modules/finance/application/services/financial-entry.service');
const receipt = require('../src/modules/finance/application/services/receipt.service');
const health = require('../src/modules/finance/application/services/finance-health.service');
const nay = require('../src/modules/finance/application/services/finance-nay.service');
const reconciliation = require('../src/modules/finance/application/services/reconciliation.service');
const bankTx = require('../src/modules/finance/application/services/bank-transactions.service');
const commissions = require('../src/modules/finance/application/services/commission.service');
const ownerRepasses = require('../src/modules/finance/application/services/owner-repasses.service');
const { readEntryComponents } = require('../src/features/analytics/read-models/financeHealth.entries');
const { financeBounds } = require('../src/features/analytics/read-models/financeHealth.dates');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { businessDateKey } = require('../src/utils/businessDate');
const { BankAccount, Person, Property, User } = require('../src/models');

after(async () => {
  await closeIsolated();
  await sequelize.close();
});

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function scenario(label) {
  const tenant = await isolatedTenant(label);
  const tx = (fn) => withTenantTransaction(tenant, fn);
  const rc = await tx(async (t) => (await createTestResultCenter(tenant, t)).id);
  const entry = (payload) => tx((t) => entriesSvc.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', resultCenterId: rc, description: `M4LR ${label} ${uniqueSuffix()}`, ...payload }, tenant.userId, t));
  const partial = (id, amount) => tx((t) => receipt.settleFinancialEntryPartial(id, amount, tenant.userId, t, { idempotencyKey: `m4lr-${uniqueSuffix()}` }));
  const report = () => tx((t) => health.getWeeklyHealthReport(t, { companyId: tenant.companyId, groupId: tenant.groupId }));
  return { tenant, tx, rc, entry, partial, report };
}

const view = (r) => ({
  aReceber: r.receivablePending.total,
  receber7d: r.dueNextSevenDays.receivable.total,
  receber30d: r.dueNext30Days.receivable.total,
  receber60d: r.dueNext60Days.receivable.total,
  necessidade: r.breathingNeed.value,
  margem: r.marginBySector.reduce((s, m) => s + m.margin, 0),
});

test('§19 + §18.1 (sondas P6 e P10): o R$ 0,30 antes, com baixa parcial de 0,10, quitado e estornado — relatório, NAY e read model contam igual', async () => {
  const s = await scenario('m4lr-030');
  const asOf = businessDateKey(new Date());
  const rm = () => s.tx((t) => readEntryComponents(s.tenant.companyId, financeBounds(asOf, 90), t));
  const recebidoNoMes = async () => {
    const ins = await s.tx((t) => nay.getFinanceInsights(s.tenant, s.tenant.userId, t, {}));
    const n = ins.explicacoes.variacoes.numeros.find((x) => x.indicador === `recebido_${asOf.slice(0, 7)}`);
    return n.valor;
  };

  const e = await s.entry({ amount: '0.30', dueAt: inDays(3) });
  assert.deepEqual(view(await s.report()), { aReceber: 0.3, receber7d: 0.3, receber30d: 0.3, receber60d: 0.3, necessidade: -0.3, margem: 0 }, 'antes');

  await s.partial(e.id, '0.10');
  const parcial = await s.report();
  assert.deepEqual(view(parcial), { aReceber: 0.2, receber7d: 0.2, receber30d: 0.2, receber60d: 0.2, necessidade: -0.2, margem: 0.1 }, 'com 0,10 recebido o saldo de 0,20 continua a receber');
  assert.equal(parcial.receivablePending.count, 1);
  assert.equal(parcial.delinquencyRatio, 0);
  const rmParcial = await rm();
  assert.equal(Number(rmParcial.receivables_7d), 0.2, 'read model do BI: o mesmo saldo');
  assert.equal(Number(rmParcial.free_cash), 0.1);
  assert.equal(await recebidoNoMes(), 0.1);

  await s.partial(e.id, '0.20');
  assert.deepEqual(view(await s.report()), { aReceber: 0, receber7d: 0, receber30d: 0, receber60d: 0, necessidade: 0, margem: 0.3 }, 'quitado: margem 0,30 para 0,30 recebidos');
  assert.equal(Number((await rm()).free_cash), 0.3, 'read model: 0,30, nunca 0,60');
  assert.equal(await recebidoNoMes(), 0.3, 'NAY: recebido no mês 0,30, nunca 0,60');

  await s.tx((t) => receipt.reverseFinancialEntry(e.id, 'estorno do recebimento de 0,30', s.tenant.userId, t));
  assert.deepEqual(view(await s.report()), { aReceber: 0, receber7d: 0, receber30d: 0, receber60d: 0, necessidade: 0, margem: 0 }, 'estornado: receita volta a zero, nada a receber');
  assert.equal(Number((await rm()).free_cash), 0);
  assert.equal(await recebidoNoMes(), 0);
});

test('§19.1 + §13.5 (sonda P12): caução de 1.000 em 400 + 600 aparece como 1.000 de terceiros; o caixa disponível soma só o conciliado, uma vez', async () => {
  const s = await scenario('m4lr-caucao');
  const account = await s.tx((t) => BankAccount.create({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, bankCode: '748', agency: '0001', accountNumber: `M4LR-${uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t }));
  const link = await s.tx((t) => createThirdPartyLink(s.tenant, t));
  const dep = await s.entry({ amount: '1000.00', isThirdPartyFunds: true, thirdPartyReference: `CAUCAO-${uniqueSuffix()}`, ...link, bankAccountId: account.id, dueAt: inDays(5) });
  const b1 = await s.partial(dep.id, '400.00');
  const b2 = await s.partial(dep.id, '600.00');
  const semConciliar = (await s.report()).freeCash;
  assert.equal(semConciliar.thirdPartyHeld, 1000, 'terceiros retidos 1.000, nunca 2.000');
  assert.equal(semConciliar.value, 0, 'nada conciliado: caixa disponível 0 (não −2.000)');

  const line = (amount, ext) => s.tx((t) => bankTx.createBankTransaction({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, bankAccountId: account.id, externalTransactionId: `${ext}-${uniqueSuffix()}`, amount, transactionDate: inDays(0), description: `M4LR ${ext}` }, s.tenant.userId, t));
  const caucaoLine = await line('1000.00', 'CAU');
  await s.tx((t) => reconciliation.matchReconciliationGroup({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, financialEntryIds: [b1.settlement.id, b2.settlement.id], bankTransactionIds: [caucaoLine.id] }, s.tenant.userId, t));
  const own = await s.entry({ amount: '500.00', bankAccountId: account.id, dueAt: inDays(1) });
  await s.tx((t) => receipt.settleFinancialEntry(own.id, s.tenant.userId, t, { idempotencyKey: `m4lr-own-${uniqueSuffix()}` }));
  const ownLine = await line('500.00', 'OWN');
  await s.tx((t) => reconciliation.matchReconciliation({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, financialEntryId: own.id, bankTransactionId: ownLine.id }, s.tenant.userId, t));
  await line('100.00', 'P1');
  await line('-100.00', 'P2');

  const r = await s.report();
  assert.equal(r.freeCash.grossBankBalance, 1500, 'extrato inteiro (informativo)');
  assert.equal(r.freeCash.conciliatedBankBalance, 1500, 'conciliado: 1.000 (uma linha, duas baixas no grupo) + 500');
  assert.equal(r.freeCash.thirdPartyHeld, 1000);
  assert.equal(r.freeCash.thirdPartyHeldConciliated, 1000);
  assert.equal(r.freeCash.value, 500, 'caixa disponível = conciliado próprio');
  assert.deepEqual({ count: r.pendingReconciliations.count, total: r.pendingReconciliations.total }, { count: 2, total: 200 }, '§19.7: entrada e saída pendentes não se anulam');
  assert.equal(r.breathingNeed.value, -500);
});

test('§19.6, §19.8, §19.9 e §19.3 (sonda P13): inadimplência só dos recebíveis, comissão paga sai do provisionado, repasse aprovado e não pago entra, peso por status', async () => {
  const s = await scenario('m4lr-indicadores');
  const cc = await s.tx((t) => createTestCostCenter(s.tenant, t));
  await s.tx((t) => entriesSvc.createFinancialEntry({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: '100.00', costCenterId: cc.id, description: `M4LR conta vencida ${uniqueSuffix()}`, dueAt: inDays(-2) }, s.tenant.userId, t));
  await s.entry({ amount: '200.00', dueAt: inDays(10) });
  const r1 = await s.report();
  assert.equal(r1.delinquencyRatio, 0, 'conta a pagar vencida não é inadimplência de cliente');
  assert.deepEqual(r1.delinquency.payable, { overdue: 100, eligible: 100, ratio: 1 });
  assert.deepEqual(r1.delinquency.receivable, { overdue: 0, eligible: 200, ratio: 0 });

  // Comissão de 100 com a parcela paga: sai do provisionado.
  await s.tx(async (t) => {
    await commissions.publishCommissionRuleVersion({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, componentPercentages: { BROKER: 10 } }, s.tenant.userId, t);
    const src = await entriesSvc.createFinancialEntry({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '1000.00', resultCenterId: s.rc, description: 'fato gerador M4LR' }, s.tenant.userId, t);
    await receipt.settleFinancialEntry(src.id, s.tenant.userId, t, { idempotencyKey: `m4lr-src-${uniqueSuffix()}` });
    const { installments } = await commissions.createCommission({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, beneficiaryUserId: s.tenant.userId, sourceEntryId: src.id, component: 'BROKER', installmentsCount: 1, idempotencyKey: `m4lr-com-${uniqueSuffix()}` }, s.tenant.userId, t);
    const before = (await health.getWeeklyHealthReport(t, { companyId: s.tenant.companyId })).provisionedCommissions;
    assert.deepEqual(before, { count: 1, total: 100 });
    const pay = await entriesSvc.createFinancialEntry({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: '100.00', costCenterId: cc.id, description: 'pagamento comissão M4LR' }, s.tenant.userId, t);
    await settleFinancialEntryWithApproval(s.tenant, pay.id, s.tenant.userId, t);
    await require('../src/modules/finance/application/services/commission-installments.service').markInstallmentPaid(installments[0].id, pay.id, s.tenant.userId, t);
  });
  assert.deepEqual((await s.report()).provisionedCommissions, { count: 0, total: 0 }, 'comissão paga não é mais provisionada');

  // Repasse aprovado e ainda não pago continua no indicador.
  await s.tx(async (t) => {
    const sfx = uniqueSuffix();
    const owner = await Person.create({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, personType: 'PF', legalName: `Proprietário M4LR ${sfx}`, createdBy: s.tenant.userId, updatedBy: s.tenant.userId }, { transaction: t });
    const property = await Property.create({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, title: `Imóvel M4LR ${sfx}`, internalCode: `M4LR-${sfx}`, propertyType: 'HOUSE', createdBy: s.tenant.userId, updatedBy: s.tenant.userId }, { transaction: t });
    const received = await entriesSvc.createFinancialEntry({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '800.00', resultCenterId: s.rc, description: `aluguel M4LR ${sfx}` }, s.tenant.userId, t);
    await receipt.settleFinancialEntry(received.id, s.tenant.userId, t, { idempotencyKey: `m4lr-rep-${sfx}` });
    const account = await BankAccount.create({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `M4LR-R-${sfx}`, status: 'ACTIVE' }, { transaction: t });
    const repasse = await ownerRepasses.createOwnerRepasse({ groupId: s.tenant.groupId, companyId: s.tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, bankAccountId: account.id, sourceEntryIds: [received.id], grossAmount: 700, deductionsAmount: 0, referenceMonth: inDays(0).slice(0, 7) }, s.tenant.userId, t);
    const checker = await User.create({ email: `m4lr-checker-${sfx}@nayaraone.dev`, name: `M4LR checker ${sfx}`, passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });
    const { repasse: approved } = await ownerRepasses.approveOwnerRepasse(repasse.id, { costCenterId: cc.id }, checker.id, t);
    assert.equal(approved.status, 'APPROVED');
  });
  const r2 = await s.report();
  assert.equal(r2.pendingOwnerRepasses.total, 700, 'aprovado e não pago é valor devido ao proprietário');
  assert.equal(r2.pendingOwnerRepasses.count, 1);

  // Peso do saldo parcialmente recebido (parâmetro do administrador): 0,5.
  await s.tx((t) => upsertSetting('finance.relatorio.peso_recebivel_parcial', 0.5, s.tenant, s.tenant.userId, t));
  const p = await s.entry({ amount: '0.30', dueAt: inDays(3) });
  await s.partial(p.id, '0.10');
  const r3 = await s.report();
  assert.equal(r3.dueNextSevenDays.receivable.total, 0.2);
  assert.equal(r3.dueNextSevenDays.receivable.weighted, 0.1, '§19.3: direitos previstos ponderados por status');
  assert.equal(r3.receivableWeights.PARCIAL, 0.5);
  assert.equal(r3.breathingNeed.probableInflows, 0.1, 'necessidade para respirar usa as entradas ponderadas');
});
