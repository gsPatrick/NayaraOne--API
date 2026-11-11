'use strict';

/**
 * Fechamento do Marco 5 — Locação: cobrança, utilidades e encerramento (bloco "Correções pós-auditoria —
 * Cobrança de locação + utilidades", Caderno M5 §12). Camada de serviço em transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');
const guaranteedRentService = require('../src/features/billing/guaranteedRent.service');
const rentAdvanceService = require('../src/features/billing/rentAdvance.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const closeoutService = require('../src/features/billing/closeout.service');
const { createMockIndexSourceAdapter } = require('../src/features/billing/adapters/IndexSourceAdapter');
const filesService = require('../src/features/files/files.service');
const { OutboxEvent, Person, UtilityObligation, OwnershipTransferTask, UtilityReimbursement, AuditLog } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function activeLease(t) {
  const c = await contractsService.createContract({ ...base(), contractType: 'LEASE', totalValue: 2500 }, tenant.userId, t);
  c.status = 'ACTIVE';
  await c.save({ transaction: t });
  return c;
}

async function evidence(t) {
  return filesService.uploadFile({ ...base(), fileName: 'conta.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(`conta ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);
}

async function events(t, aggregateIds) {
  const rows = await OutboxEvent.findAll({ where: { aggregateId: aggregateIds }, transaction: t });
  return rows.map((e) => e.eventType);
}

test('fechamento M5 cobrança: billing.generated, rent.adjusted, charge.overdue, guaranteed_rent.paid, advance.completed, utility.transfer.required/completed, reimbursement.created e closeout.blocked/completed vão para o outbox', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await activeLease(t);
    const schedule = await billingScheduleService.generateBillingSchedule({ ...base(), contractId: ct.id, period: '2031-01', dueDate: '2031-01-10', items: [{ componentType: 'RENT', amount: 2500 }] }, tenant.userId, t);
    const pending = await rentAdjustmentService.requestRentAdjustment({ ...base(), contractId: ct.id, indexCode: 'INPC', period: '2031-01', oldRentAmount: 2500 }, tenant.userId, t);
    const applied = await rentAdjustmentService.requestRentAdjustment({ ...base(), contractId: ct.id, indexCode: 'IPCA', period: '2031-02', oldRentAmount: 2500 }, tenant.userId, t, createMockIndexSourceAdapter({ 'IPCA:2031-02': 4 }));
    const kase = await collectionCaseService.openCollectionCase(schedule.id, 45, tenant.userId, t);
    const gr = await guaranteedRentService.enrollGuaranteedRent({ ...base(), contractId: ct.id, coverageStartsAt: '2031-01-01' }, tenant.userId, t);
    await guaranteedRentService.payGuaranteedRent(gr.id, { period: '2031-01', amount: 2500 }, tenant.userId, t);
    const adv = await rentAdvanceService.requestRentAdvance({ ...base(), contractId: ct.id, monthsAdvanced: 2, principalAmount: 5000, costAmount: 200 }, tenant.userId, t);
    await rentAdvanceService.proposeRentAdvance(adv.id, tenant.userId, t);
    await rentAdvanceService.acceptRentAdvance(adv.id, tenant.userId, t);
    await rentAdvanceService.payRentAdvance(adv.id, tenant.userId, t);
    await rentAdvanceService.recoverRentAdvance(adv.id, 5200, tenant.userId, t);
    const renter = await Person.create({ ...base(), personType: 'PF', legalName: `M5F locatário ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
    const { obligation, transferTask } = await utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'ELECTRICITY', responsibleParty: 'TENANT', transferRequired: true, transferToPersonId: renter.id }, tenant.userId, t);
    const { reimbursement } = await utilitiesService.recordUtilityPayment(obligation.id, { amount: 180.4, paidByParty: 'COMPANY' }, tenant.userId, t);
    await assert.rejects(closeoutService.closeoutContract(ct.id, tenant.userId, t), (err) => err.code === 'CLOSEOUT_BLOCKED');
    await utilitiesService.completeOwnershipTransfer(transferTask.id, { evidenceFileId: (await evidence(t)).id }, tenant.userId, t);

    const clean = await activeLease(t);
    const done = await closeoutService.closeoutContract(clean.id, tenant.userId, t);
    assert.equal(done.status, 'COMPLETED');

    const got = await events(t, [schedule.id, pending.id, applied.id, kase.id, gr.id, adv.id, transferTask.id, reimbursement.id, ct.id, clean.id]);
    for (const type of ['billing.generated', 'rent.adjusted', 'charge.overdue', 'guaranteed_rent.paid', 'advance.completed', 'utility.transfer.required', 'utility.transfer.completed', 'reimbursement.created', 'closeout.blocked', 'closeout.completed']) {
      assert.ok(got.includes(type), `evento ${type} ausente`);
    }
    assert.equal(got.filter((e) => e === 'rent.adjusted').length, 2, 'rent.adjusted também no PENDING_SOURCE');
  });
});

test('fechamento M5 §12: água, luz, gás, condomínio, IPTU, SPU e outra ficam vinculadas ao contrato com responsável, provedor, conta, troca exigida, evidência e status', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await activeLease(t);
    const file = await evidence(t);
    for (const utilityType of utilitiesService.UTILITY_TYPES) {
      const transferRequired = ['WATER', 'ELECTRICITY'].includes(utilityType);
      const { obligation, transferTask } = await utilitiesService.createUtilityObligation(
        { ...base(), contractId: ct.id, utilityType, responsibleParty: utilityType === 'IPTU' ? 'LANDLORD' : 'TENANT', provider: `Fornecedor ${utilityType}`, accountNumber: `C-${utilityType}`, transferRequired, evidenceFileId: file.id },
        tenant.userId,
        t
      );
      const row = await UtilityObligation.findByPk(obligation.id, { transaction: t });
      assert.equal(row.contractId, ct.id);
      assert.equal(row.provider, `Fornecedor ${utilityType}`);
      assert.equal(row.accountNumber, `C-${utilityType}`);
      assert.equal(row.evidenceFileId, file.id);
      assert.equal(row.transferRequired, transferRequired);
      assert.equal(row.status, transferRequired ? 'TRANSFER_PENDING' : 'ACTIVE');
      assert.equal(Boolean(transferTask), transferRequired, 'troca de titularidade vira tarefa');
    }
    assert.deepEqual([...utilitiesService.UTILITY_TYPES].sort(), ['CONDO', 'ELECTRICITY', 'GAS', 'IPTU', 'OTHER', 'SPU', 'WATER']);
    await assert.rejects(utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'INTERNET', responsibleParty: 'TENANT' }, tenant.userId, t), (err) => err.code === 'UTILITY_OBLIGATION_VALIDATION');
    await assert.rejects(utilitiesService.createUtilityObligation({ ...base(), contractId: '00000000-0000-4000-8000-000000000009', utilityType: 'WATER', responsibleParty: 'TENANT' }, tenant.userId, t), (err) => err.code === 'UTILITY_OBLIGATION_CONTRACT_NOT_FOUND');
  });
});

test('fechamento M5 §12: pendência não some quando o contrato tenta encerrar — closeout bloqueado mantém obrigação, tarefa de titularidade e reembolso com o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await activeLease(t);
    const { obligation, transferTask } = await utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT', transferRequired: true }, tenant.userId, t);
    const { reimbursement, financialEntry } = await utilitiesService.recordUtilityPayment(obligation.id, { amount: 95.5, paidByParty: 'COMPANY' }, tenant.userId, t);
    await assert.rejects(closeoutService.closeoutContract(ct.id, tenant.userId, t), (err) => {
      assert.equal(err.code, 'CLOSEOUT_BLOCKED');
      assert.ok(err.details.reasons.some((r) => r.type === 'PENDING_UTILITY_TRANSFER' && r.ownershipTransferTaskIds.includes(transferTask.id)));
      return true;
    });
    assert.equal((await OwnershipTransferTask.findByPk(transferTask.id, { transaction: t })).status, 'PENDING');
    assert.ok(await UtilityObligation.findByPk(obligation.id, { transaction: t }));
    const r = await UtilityReimbursement.findByPk(reimbursement.id, { transaction: t });
    assert.equal(r.status, 'PENDING');
    assert.equal(r.financialEntryId, financialEntry.id);
    assert.equal(financialEntry.contractId, ct.id);
    assert.equal(financialEntry.nature, 'RECEIVABLE');
    const audit = await AuditLog.findOne({ where: { action: 'billing.closeout.blocked', entityId: ct.id }, transaction: t });
    assert.ok(audit, 'bloqueio auditado');
  });
});
