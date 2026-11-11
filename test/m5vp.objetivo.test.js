'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0002, livro §1 "Objetivo" (L15-17), uma prova por garantia:
 *  1. nenhum contrato avança sem documentação e aprovações obrigatórias;
 *  2. a locação mantém histórico completo de garantias e obrigações;
 *  3. vistorias são comparáveis e assinadas;
 *  4. processos/prazos jurídicos têm rastreabilidade, evidência e alertas.
 * E M5-A0309 (JUR-012): reparos entram na linha do tempo do contrato (dano de vistoria e registro de reparo do imóvel).
 * Serviço real em transação desfeita (RLS do tenant de seed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const guaranteesService = require('../src/modules/legal/leasing/guarantee.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const propertiesService = require('../src/features/properties/properties.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const maintenanceService = require('../src/features/construction/maintenanceCases.service');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const { getContractTimeline } = require('../src/modules/legal/contracts/application/contractTimeline.service');
const { processLeaseObligations } = require('../src/features/billing/obligations/leaseObligationOverdue');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { Contract, Guarantee, AuditLog, LeaseObligationCycle, OutboxEvent, Notification, LegalDeadline } = require('../src/models');
const { completeInsurance, paymentProof } = require('./m5fech.locacao.helpers');
const { newUser, newCase, newDeadline, PAST, FUTURE } = require('./m5fech.juridico.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const property = (t) => {
  const sfx = uniqueSuffix();
  return propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5VP objetivo ${sfx}`, internalCode: `M5VP-OB-${sfx}` }, tenant.userId, t);
};

test('M5-A0002 (1): contrato não avança sem os documentos obrigatórios nem sem a versão aprovada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE_RESIDENTIAL', totalValue: 1800 }, tenant.userId, t);
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
    await assert.rejects(() => contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, t), (err) => err.code === 'LEGAL_REQUIREMENTS_PENDING');
    assert.equal((await Contract.findByPk(contract.id, { transaction: t })).status, 'DRAFT');
    // Mesmo com o checklist dispensado, assinatura exige versão aprovada (o contrato não pula a aprovação).
    for (const r of await requirementsService.listRequirements(contract.id, t)) await requirementsService.satisfyRequirement(r.id, { waivedReason: 'Dispensa do teste do objetivo' }, tenant.userId, t);
    const fresh = await Contract.findByPk(contract.id, { transaction: t });
    await assert.rejects(() => contractsService.transitionContractStatus(fresh, 'SIGNING', tenant.userId, t));
    assert.notEqual((await Contract.findByPk(contract.id, { transaction: t })).status, 'SIGNING');
  });
});

test('M5-A0002 (2): histórico completo de garantias (substituída preservada e imutável) e de obrigações (cada vencimento fica registrado)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contract = await Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-OB-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const first = await guaranteesService.createGuarantee(contract.id, await completeInsurance(tenant, t), tenant.userId, t);
    const { newGuarantee } = await guaranteesService.replaceGuarantee(first.id, await completeInsurance(tenant, t), tenant.userId, t);
    const all = await Guarantee.findAll({ where: { contractId: contract.id }, paranoid: false, transaction: t });
    assert.equal(all.length, 2, 'as duas garantias continuam no contrato');
    assert.equal(all.find((g) => g.id === first.id).replacedByGuaranteeId, newGuarantee.id);
    await assert.rejects(() => guaranteesService.deleteGuarantee(first.id, tenant.userId, t), (err) => err.code === 'LEGAL_GUARANTEE_REPLACED_IMMUTABLE');
    const trail = await AuditLog.findAll({ where: { entityType: 'Guarantee', entityId: first.id }, transaction: t });
    assert.deepEqual(trail.map((a) => a.action).sort(), ['legal.guarantee.create', 'legal.guarantee.replace']);

    const { obligation } = await utilitiesService.createUtilityObligation({ ...base(), contractId: contract.id, utilityType: 'CONDO', responsibleParty: 'TENANT', dueDay: 5 }, tenant.userId, t);
    obligation.startsOn = '2027-01-01';
    obligation.nextDueOn = '2027-01-05';
    await obligation.save({ transaction: t });
    await processLeaseObligations(t, { now: new Date('2027-03-20T12:00:00Z') });
    await utilitiesService.recordUtilityPayment(obligation.id, { amount: 600, paidByParty: 'TENANT', ...(await paymentProof(tenant, t, '2027-02-05')) }, tenant.userId, t);
    await processLeaseObligations(t, { now: new Date('2027-03-20T12:00:00Z') });
    const cycles = await LeaseObligationCycle.findAll({ where: { obligationId: obligation.id }, order: [['dueOn', 'ASC']], transaction: t });
    assert.deepEqual(cycles.map((c) => [c.dueOn, c.status]), [['2027-01-05', 'OVERDUE'], ['2027-02-05', 'PAID'], ['2027-03-05', 'OVERDUE'], ['2027-04-05', 'OPEN']]);
  });
});

test('M5-A0002 (3): vistorias de entrada e saída são assinadas (congeladas) e comparáveis item a item', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const contract = await Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-OV-${uniqueSuffix()}`, propertyId: p.id, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const make = async (type, condition) => {
      const ins = await inspectionsService.createInspection({ ...base(), propertyId: p.id, contractId: contract.id, inspectionType: type }, tenant.userId, t);
      await inspectionsService.addInspectionItem(ins.id, { itemName: 'Sala — piso', condition, ...(condition === 'DAMAGED' ? { damageDescription: 'Riscos fundos', estimatedBudget: 450, responsibleParty: 'UNDETERMINED' } : {}) }, tenant.userId, t);
      await inspectionsService.completeInspection(ins.id, tenant.userId, t);
      await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
      await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
      return ins;
    };
    const entry = await make('ENTRY', 'GOOD');
    const exit = await make('EXIT', 'DAMAGED');
    await assert.rejects(() => inspectionsService.addInspectionItem(entry.id, { itemName: 'Cozinha', condition: 'GOOD' }, tenant.userId, t), (err) => err.code === 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE');
    const result = await inspectionsService.compareInspections(entry.id, exit.id, t);
    const sala = result.items.find((i) => i.itemName === 'Sala — piso');
    assert.equal(sala.changed, true);
    assert.equal(result.requiresHumanValidation, true);
  });
});

test('M5-A0002 (4): prazo jurídico com origem, alerta ao responsável, evento de vencido e conclusão só com evidência', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: owner.id });
    await assert.rejects(() => newDeadline(legalCase.id, tenant, t, { sourceFileId: undefined, sourceDocument: undefined }));
    const d = await newDeadline(legalCase.id, tenant, t, { dueAt: PAST(1), responsibleUserId: owner.id, criticality: 'HIGH' });
    assert.ok(d.sourceFileId, 'rastreável até a origem');
    await processDeadlinesInTransaction(t, new Date());
    assert.ok(await Notification.findOne({ where: { userId: owner.id, title: 'Prazo jurídico VENCIDO' }, transaction: t }), 'alerta ao responsável');
    assert.ok(await OutboxEvent.findOne({ where: { eventType: 'legal.deadline.overdue', aggregateId: d.id }, transaction: t }));
    assert.ok((await LegalDeadline.findByPk(d.id, { transaction: t })).occurrenceTaskId, 'ocorrência HIGH aberta');
    await assert.rejects(() => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE' }, tenant.userId, t));
    const next = await newDeadline(legalCase.id, tenant, t, { dueAt: FUTURE(1), responsibleUserId: owner.id });
    await processDeadlinesInTransaction(t, new Date());
    assert.equal((await LegalDeadline.findByPk(next.id, { transaction: t })).lastAlertedSeverity, 'DUE_SOON', 'aviso antes de vencer');
  });
});

test('M5-A0309/JUR-012: reparos entram na linha do tempo — dano apontado em vistoria e registro de reparo do imóvel durante o contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const other = await property(t);
    const contract = await Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-TL-${uniqueSuffix()}`, propertyId: p.id, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const exit = await inspectionsService.createInspection({ ...base(), propertyId: p.id, contractId: contract.id, inspectionType: 'EXIT' }, tenant.userId, t);
    const damaged = await inspectionsService.addInspectionItem(exit.id, { itemName: 'Banheiro — box', condition: 'DAMAGED', damageDescription: 'Vidro trincado', estimatedBudget: 380, responsibleParty: 'UNDETERMINED' }, tenant.userId, t);
    const repair = await maintenanceService.createMaintenanceCase({ ...base(), propertyId: p.id, description: 'Troca do vidro do box do banheiro' }, tenant.userId, t);
    await maintenanceService.createMaintenanceCase({ ...base(), propertyId: other.id, description: 'Reparo em outro imóvel' }, tenant.userId, t);
    const { items } = await getContractTimeline(contract.id, t);
    const repairs = items.filter((i) => i.type === 'REPAIR');
    assert.deepEqual(repairs.map((r) => r.referenceId).sort(), [damaged.id, repair.id].sort(), 'só os reparos deste imóvel/contrato');
    assert.match(repairs.find((r) => r.referenceId === repair.id).summary, /Troca do vidro do box/);
    assert.match(repairs.find((r) => r.referenceId === damaged.id).summary, /Vidro trincado/);
  });
});
