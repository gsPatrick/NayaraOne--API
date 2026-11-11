'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — obrigações da locação, livro §12 "Cada obrigação possui responsável, periodicidade,
 * comprovante e status"; "Pendência gera alerta/cobrança; não some quando contrato encerra"; §18 lease.obligation.overdue;
 * DEC-074 (origens CYCLE, TRANSFER, REIMBURSEMENT, chave lease.obligation.overdue:<obrigação>:<origem>:<id>).
 * M5-A0096, M5-A0171, M5-A0187, M5-A0248, M5-A0270, M5-A0228, M5-A0192, M5-A0273, M5-A0346 (chave natural do pagamento).
 * Serviço e job reais em transação desfeita (RLS do tenant de seed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const utilitiesService = require('../src/features/billing/utilities.service');
const { processLeaseObligations } = require('../src/features/billing/obligations/leaseObligationOverdue');
const cyclesService = require('../src/features/billing/obligations/obligationCycles.service');
const closureGate = require('../src/modules/legal/contracts/domain/contractClosureGate');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { Contract, LeaseObligationCycle, OutboxEvent, Task, Notification, UtilityReimbursement, OwnershipTransferTask } = require('../src/models');
const { uploadTestFile } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };
const set = (key, value, t) => upsertSetting(key, value, tenant, tenant.userId, t);
const at = (ymd) => new Date(`${ymd}T15:00:00Z`);

/** Locação ACTIVE com uma obrigação já iniciada pela entrega das chaves (início e primeiro vencimento). */
async function startedObligation(t, { utilityType = 'WATER', responsibleParty = 'TENANT', periodicity, dueDay = 10, startsOn = '2027-01-05', nextDueOn = '2027-01-10', transferRequired = false } = {}) {
  const contract = await Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-O-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
  const { obligation, transferTask } = await utilitiesService.createUtilityObligation({ ...base(), contractId: contract.id, utilityType, responsibleParty, periodicity, dueDay, transferRequired }, tenant.userId, t);
  obligation.startsOn = startsOn;
  obligation.nextDueOn = nextDueOn;
  await obligation.save({ transaction: t });
  return { contract, obligation, transferTask };
}

const cyclesOf = (obligationId, t) => LeaseObligationCycle.findAll({ where: { obligationId }, order: [['dueOn', 'ASC']], transaction: t });
const overdueEvents = (aggregateId, t) => OutboxEvent.findAll({ where: { eventType: 'lease.obligation.overdue', aggregateId }, transaction: t });

test('M5-A0171/§12: o vencimento avança pela periodicidade — um ciclo por vencimento, mensal e anual, sem duplicar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { obligation: agua } = await startedObligation(t);
    const { obligation: iptu } = await startedObligation(t, { utilityType: 'IPTU', responsibleParty: 'LANDLORD', dueDay: 20, nextDueOn: '2027-02-20' });
    assert.equal(iptu.periodicity, 'ANNUAL');
    await processLeaseObligations(t, { now: at('2027-04-15') });
    assert.deepEqual((await cyclesOf(agua.id, t)).map((c) => c.dueOn), ['2027-01-10', '2027-02-10', '2027-03-10', '2027-04-10', '2027-05-10']);
    assert.deepEqual((await cyclesOf(iptu.id, t)).map((c) => c.dueOn), ['2027-02-20', '2028-02-20']);
    await agua.reload({ transaction: t });
    await iptu.reload({ transaction: t });
    assert.equal(agua.nextDueOn, '2027-05-10', 'próximo vencimento avançou');
    assert.equal(iptu.nextDueOn, '2028-02-20');
    const again = await processLeaseObligations(t, { now: at('2027-04-15') });
    assert.equal(again.cyclesCreated, 0, 'idempotente');
  });
});

test('M5-A0096/M5-A0228: vencimento sem comprovante depois da carência gera alerta, cobrança e lease.obligation.overdue (CYCLE) uma vez; a carência é parâmetro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, obligation } = await startedObligation(t);
    await processLeaseObligations(t, { now: at('2027-01-14') }); // 4 dias depois: dentro da carência padrão (5)
    let [first] = await cyclesOf(obligation.id, t);
    assert.equal(first.status, 'OPEN');
    await processLeaseObligations(t, { now: at('2027-01-16') }); // 6 dias depois
    [first] = await cyclesOf(obligation.id, t);
    assert.equal(first.status, 'OVERDUE');
    const events = await overdueEvents(first.id, t);
    assert.equal(events.length, 1);
    assert.equal(events[0].idempotencyKey, `lease.obligation.overdue:${obligation.id}:CYCLE:${first.id}`);
    assert.deepEqual([events[0].payloadJson.sourceType, events[0].payloadJson.period, events[0].payloadJson.owedBy], ['CYCLE', '2027-01-10', 'TENANT']);
    const cobranca = await Task.findByPk(first.collectionTaskId, { transaction: t });
    assert.match(cobranca.title, /^Cobrança: água/);
    assert.equal(cobranca.assignedToUserId, contract.createdBy);
    assert.ok(await Notification.findOne({ where: { userId: contract.createdBy, title: 'Obrigação da locação vencida' }, transaction: t }), 'alerta');
    await processLeaseObligations(t, { now: at('2027-01-20') });
    assert.equal((await overdueEvents(first.id, t)).length, 1, 'não repete');
    assert.equal(await Task.count({ where: { relatedEntityId: first.id }, transaction: t }), 1);

    // Carência configurada em 0: o vencimento de fevereiro já vence no dia seguinte.
    await set('billing.utility_proof_grace_days', 0, t);
    await processLeaseObligations(t, { now: at('2027-02-11') });
    const feb = (await cyclesOf(obligation.id, t)).find((c) => c.dueOn === '2027-02-10');
    assert.equal(feb.status, 'OVERDUE');
  });
});

test('M5-A0346/§12: o pagamento é de um vencimento, com comprovante; repetir o mesmo vencimento não gera segundo reembolso (com ou sem Idempotency-Key)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { obligation } = await startedObligation(t);
    await processLeaseObligations(t, { now: at('2027-01-20') });
    const proof = await uploadTestFile(tenant, t, 'comprovante-agua.pdf');
    await assert.rejects(() => utilitiesService.recordUtilityPayment(obligation.id, { amount: 80, paidByParty: 'COMPANY' }, tenant.userId, t), code('UTILITY_RECEIPT_REQUIRED'));
    const first = await utilitiesService.recordUtilityPayment(obligation.id, { amount: 80, paidByParty: 'COMPANY', referenceDueOn: '2027-01-10', proofFileId: proof.id }, tenant.userId, t);
    assert.equal(first.cycle.status, 'PAID');
    assert.equal(first.cycle.reimbursementId, first.reimbursement.id);
    // UAT M5 (texto do reembolso): concordância "pago pela imobiliária, a cobrar do locatário" (antes "pago por o ...").
    assert.equal(first.financialEntry.description, 'Reembolso de água pago pela imobiliária, a cobrar do locatário.');
    const { reimbursementDescription } = require('../src/features/billing/obligations/utilityPayment.service');
    assert.equal(reimbursementDescription('IPTU', 'LANDLORD', 'TENANT'), 'Reembolso de IPTU pago pelo locador, a cobrar do locatário.');
    assert.equal(reimbursementDescription('CONDO', 'TENANT', 'LANDLORD'), 'Reembolso de condomínio pago pelo locatário, a cobrar do locador.');
    const proof2 = await uploadTestFile(tenant, t);
    await assert.rejects(() => utilitiesService.recordUtilityPayment(obligation.id, { amount: 80, paidByParty: 'COMPANY', referenceDueOn: '2027-01-10', proofFileId: proof2.id }, tenant.userId, t), code('UTILITY_CYCLE_ALREADY_SETTLED'));
    assert.equal(await UtilityReimbursement.count({ where: { utilityObligationId: obligation.id }, transaction: t }), 1, 'um reembolso só');
    await assert.rejects(() => utilitiesService.recordUtilityPayment(obligation.id, { amount: 80, paidByParty: 'TENANT', referenceDueOn: '2027-02-10', proofFileId: proof.id }, tenant.userId, t), code('UTILITY_RECEIPT_ALREADY_USED'));
    // Sem referência, paga o vencimento aberto mais antigo; a parte responsável pagando não gera reembolso.
    const own = await utilitiesService.recordUtilityPayment(obligation.id, { amount: 80, paidByParty: 'TENANT', proofFileId: (await uploadTestFile(tenant, t)).id }, tenant.userId, t);
    assert.equal(own.reimbursement, null);
    assert.equal(own.cycle.dueOn, '2027-02-10');
    // Ciclo pago não vence.
    await processLeaseObligations(t, { now: at('2027-03-01') });
    const cycles = await cyclesOf(obligation.id, t);
    assert.deepEqual(cycles.slice(0, 2).map((c) => c.status), ['PAID', 'PAID']);
  });
});

test('M5-A0228/DEC-074: troca de titularidade atrasada (prazo configurável, não mais 30 fixo) e reembolso não recebido também publicam o evento, com alerta e cobrança', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { obligation, transferTask } = await startedObligation(t, { transferRequired: true });
    await set('locacao.titularidade.prazo_dias', 10, t);
    const now = new Date();
    await processLeaseObligations(t, { now: new Date(now.getTime() + 9 * 86400000) });
    assert.equal((await overdueEvents(transferTask.id, t)).length, 0);
    await processLeaseObligations(t, { now: new Date(now.getTime() + 11 * 86400000) });
    const [ev] = await overdueEvents(transferTask.id, t);
    assert.equal(ev.idempotencyKey, `lease.obligation.overdue:${obligation.id}:TRANSFER:${transferTask.id}`);
    assert.equal(ev.payloadJson.utilityObligationId, obligation.id);
    assert.equal(await Task.count({ where: { relatedEntityType: 'lease_obligation.transfer', relatedEntityId: transferTask.id }, transaction: t }), 1);
    assert.equal((await OwnershipTransferTask.findByPk(transferTask.id, { transaction: t })).status, 'PENDING', 'a pendência não some');

    await set('billing.reimbursement_overdue_alert_days', 10, t);
    const { reimbursement } = await utilitiesService.recordUtilityPayment(obligation.id, { amount: 55.5, paidByParty: 'COMPANY', referenceDueOn: '2027-01-10', proofFileId: (await uploadTestFile(tenant, t)).id }, tenant.userId, t);
    await processLeaseObligations(t, { now: new Date(now.getTime() + 9 * 86400000) });
    assert.equal((await overdueEvents(reimbursement.id, t)).length, 0);
    await processLeaseObligations(t, { now: new Date(now.getTime() + 12 * 86400000) });
    const [evR] = await overdueEvents(reimbursement.id, t);
    assert.equal(evR.idempotencyKey, `lease.obligation.overdue:${obligation.id}:REIMBURSEMENT:${reimbursement.id}`);
    assert.equal(evR.payloadJson.owedBy, 'TENANT');
    assert.equal(await Task.count({ where: { relatedEntityType: 'lease_obligation.reimbursement', relatedEntityId: reimbursement.id }, transaction: t }), 1);
  });
});

test('M5-A0270 e "obrigação crítica": vencimento sem comprovante segura o encerramento (configurável) e não some; dispensa registrada libera', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, obligation } = await startedObligation(t);
    await processLeaseObligations(t, { now: at('2027-01-20') });
    const [overdue] = await cyclesOf(obligation.id, t);
    assert.equal(overdue.status, 'OVERDUE');
    await assert.rejects(() => closureGate.assertContractClosureAllowed(contract.id, t), (err) => {
      assert.equal(err.code, 'LEGAL_CONTRACT_CLOSURE_BLOCKED');
      assert.ok(err.details.pendencies.some((p) => p.type === 'OVERDUE_OBLIGATION_CYCLE' && p.cycleIds.includes(overdue.id)));
      return true;
    });
    await set('locacao.encerramento.bloqueia.CYCLE_OVERDUE', false, t);
    assert.ok(!(await closureGate.collectContractClosurePendencies(contract.id, t)).some((p) => p.type === 'OVERDUE_OBLIGATION_CYCLE'));
    await set('locacao.encerramento.bloqueia.CYCLE_OVERDUE', true, t);

    await assert.rejects(() => cyclesService.waiveCycle(overdue.id, { reason: 'curto' }, tenant.userId, t), code('UTILITY_WAIVE_REASON_REQUIRED'));
    const waived = await cyclesService.waiveCycle(overdue.id, { reason: 'Concessionária confirmou débito quitado pelo locatário' }, tenant.userId, t);
    assert.equal(waived.status, 'WAIVED');
    assert.ok(!(await closureGate.collectContractClosurePendencies(contract.id, t)).some((p) => p.type === 'OVERDUE_OBLIGATION_CYCLE'));
    assert.equal((await cyclesOf(obligation.id, t)).length >= 1, true, 'o ciclo continua registrado');

    // Reembolso a receber: só segura o encerramento se a empresa ligar o parâmetro (padrão: não segura, como já era).
    await utilitiesService.recordUtilityPayment(obligation.id, { amount: 40, paidByParty: 'COMPANY', referenceDueOn: '2027-02-10', proofFileId: (await uploadTestFile(tenant, t)).id }, tenant.userId, t);
    assert.ok(!(await closureGate.collectContractClosurePendencies(contract.id, t)).some((p) => p.type === 'PENDING_REIMBURSEMENT'));
    await set('locacao.encerramento.bloqueia.REIMBURSEMENT_PENDING', true, t);
    assert.ok((await closureGate.collectContractClosurePendencies(contract.id, t)).some((p) => p.type === 'PENDING_REIMBURSEMENT'));
  });
});
