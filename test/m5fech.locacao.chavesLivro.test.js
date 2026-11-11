'use strict';

/**
 * Fechamento do Marco 5 — Locação, segunda onda: gates do livro na entrega de chaves (Caderno §10, JUR-005, Guia §11):
 * checklist da etapa KEY_DELIVERY pelo Motor de Regras, assinatura do termo com a via assinada e o consumidor de
 * keys.delivered que inicia as obrigações da locação. Camada de serviço em transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const { startLeaseObligationsOnKeysDelivered } = require('../src/features/billing/keysDeliveredObligations.consumer');
const { runEventConsumers } = require('../src/engines/events/consumers');
const { OutboxEvent, UtilityObligation, OwnershipTransferTask, KeyDelivery } = require('../src/models');
const { keyDeliveryReady, uploadTestFile } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };

async function signedLease(t) {
  const sfx = uniqueSuffix();
  const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F livro ${sfx}`, internalCode: `M5FK-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE', propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  contract.status = 'SIGNED';
  await contract.save({ transaction: t });
  const landlord = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F Locador ${sfx}` }, tenant.userId, t);
  const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F Locatário ${sfx}` }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
  const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
  return { contract, renter, landlord };
}

test('fechamento M5 §10/JUR-005/Guia §11: checklist da etapa KEY_DELIVERY (Motor de Regras) pendente bloqueia a entrega; dispensado ou satisfeito, libera', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, renter } = await signedLease(t);
    const term = await uploadTestFile(tenant, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    const body = { keysCount: 2, keysIdentification: 'chave e controle', termSignedByPersonId: renter.id, termEvidenceFileId: term.id };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), (err) => {
      assert.equal(err.code, 'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING');
      assert.ok(err.details.pending.length > 0, 'lista as exigências pendentes');
      return true;
    });
    const items = await requirementsService.listRequirements(contract.id, t);
    assert.ok(items.length > 0, 'o checklist foi gerado pelo Motor de Regras (fail closed)');
    for (const item of items) await requirementsService.satisfyRequirement(item.id, { waivedReason: 'Dispensa de teste do fechamento M5' }, tenant.userId, t);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
  });
});

test('fechamento M5 §10: assinatura do termo de entrega exige a via assinada (arquivo da empresa) e guarda o SHA-256 dela', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, renter } = await signedLease(t);
    await keyDeliveryReady(tenant, contract.id, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    const body = { keysCount: 1, keysIdentification: 'porta', termSignedByPersonId: renter.id };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), code('LEGAL_KEY_DELIVERY_TERM_EVIDENCE_REQUIRED'));
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, termEvidenceFileId: '11111111-1111-4111-8111-111111111111' }, tenant.userId, t), code('LEGAL_KEY_DELIVERY_TERM_EVIDENCE_INVALID'));
    const via = await uploadTestFile(tenant, t, 'termo-assinado.pdf');
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, termEvidenceFileId: via.id }, tenant.userId, t);
    const row = await KeyDelivery.findByPk(released.id, { transaction: t });
    assert.deepEqual([row.termEvidenceFileId, row.termEvidenceSha256, row.termSignatureMethod], [via.id, via.checksumSha256, 'MANUAL_EVIDENCE']);
  });
});

test('fechamento M5 §10 (M5-D103): keys.delivered inicia as obrigações — início e próximo vencimento pela periodicidade e prazo da troca de titularidade; reentrega não muda nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, renter } = await signedLease(t);
    const term = await keyDeliveryReady(tenant, contract.id, t);
    const { obligation: agua, transferTask } = await utilitiesService.createUtilityObligation({ ...base(), contractId: contract.id, utilityType: 'WATER', responsibleParty: 'TENANT', transferRequired: true, dueDay: 10 }, tenant.userId, t);
    const { obligation: iptu } = await utilitiesService.createUtilityObligation({ ...base(), contractId: contract.id, utilityType: 'IPTU', responsibleParty: 'LANDLORD' }, tenant.userId, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 1, keysIdentification: 'porta', termSignedByPersonId: renter.id, termEvidenceFileId: term }, tenant.userId, t);
    await KeyDelivery.update({ deliveredAt: new Date('2026-11-12T15:00:00Z') }, { where: { id: kd.id }, transaction: t });
    const event = await OutboxEvent.findOne({ where: { eventType: 'keys.delivered', aggregateId: kd.id }, transaction: t });
    const ran = await runEventConsumers(event, t);
    assert.ok(ran.includes('locacao.obrigacoes'), 'consumidor registrado no motor de eventos');
    const a = await UtilityObligation.findByPk(agua.id, { transaction: t });
    const i = await UtilityObligation.findByPk(iptu.id, { transaction: t });
    assert.deepEqual([a.periodicity, a.startsOn, a.nextDueOn], ['MONTHLY', '2026-11-12', '2026-12-10']);
    assert.deepEqual([i.periodicity, i.startsOn, i.nextDueOn], ['ANNUAL', '2026-11-12', '2027-11-12']);
    assert.equal((await OwnershipTransferTask.findByPk(transferTask.id, { transaction: t })).dueDate, '2026-12-12', 'prazo padrão de 30 dias da entrega');
    const again = await startLeaseObligationsOnKeysDelivered(event, t);
    assert.deepEqual([again.started, again.deadlines], [0, 0], 'reentrega idempotente');
    const overdue = await utilitiesService.flagOverdueLeaseObligations(t, { now: new Date('2026-12-13T12:00:00Z') });
    assert.ok(overdue.flagged >= 1, 'vence pelo prazo contado da entrega');
  });
});
