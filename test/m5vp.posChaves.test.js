'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0086, livro §10 "Evento keys.delivered inicia pós-chaves/cadências e obrigações".
 * Prova de ponta a ponta: a liberação REAL das chaves publica keys.delivered e os consumidores do motor de eventos rodam sobre
 * esse mesmo evento do outbox — o Marketing agenda a cadência pós-chaves (3/30/90/365 dias) e a Locação inicia as obrigações
 * (início, vencimento e, pelo job, o primeiro ciclo). Transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const cadence = require('./marco9/_helpers/mktCadencia');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const peopleService = require('../src/features/people/people.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const filesService = require('../src/features/files/files.service');
const { runEventConsumers } = require('../src/engines/events/consumers');
const { processLeaseObligations } = require('../src/features/billing/obligations/leaseObligationOverdue');
const { OutboxEvent, UtilityObligation, LeaseObligationCycle } = require('../src/models');
require('../src/features/billing/billing.routes'); // registra o consumidor locacao.obrigacoes, como a API em produção

let tenant;
let offVault;
before(async () => { ({ tenantA: tenant } = await cadence.prepararTenants()); offVault = cadence.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const upload = (t, name, mimeType) => filesService.uploadFile({ ...base(), fileName: name, mimeType, contentBase64: Buffer.from(`${name} ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);

async function releaseFor(t, { contractType, role, personId, inspectionType, photos }) {
  const sfx = uniqueSuffix();
  const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5VP pós-chaves ${sfx}`, internalCode: `M5VP-PC-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType, propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId, partyRole: role }, tenant.userId, t);
  contract.status = contractType.startsWith('SALE') ? 'SIGNED' : 'ACTIVE';
  await contract.save({ transaction: t });
  const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
  await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
  for (const r of await requirementsService.listRequirements(contract.id, t)) await requirementsService.satisfyRequirement(r.id, { waivedReason: 'Dispensa do teste pós-chaves' }, tenant.userId, t);
  return { contract, photos: photos ? [(await upload(t, 'fachada.png', 'image/png')).id] : undefined, term: (await upload(t, 'termo.pdf', 'application/pdf')).id };
}

test('M5-A0086/§10: keys.delivered da liberação real inicia a cadência pós-chaves (Marketing) e as obrigações da locação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await cadence.install(t, tenant, 'POS-CHAVES');
    // Venda (casa nova): o comprador com consentimento de pós-venda entra na cadência pós-chaves.
    const buyer = await cadence.person(t, tenant);
    const sale = await releaseFor(t, { contractType: 'SALE_CASH', role: 'BUYER', personId: buyer, inspectionType: 'FINAL', photos: true });
    const kdSale = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: sale.contract.id, deliveredToPersonId: buyer }, tenant.userId, t);
    await keyDeliveriesService.releaseKeyDelivery(kdSale.id, { keysCount: 2, keysIdentification: '2 chaves da porta', termSignedByPersonId: buyer, photosFileIds: sale.photos, termEvidenceFileId: sale.term }, tenant.userId, t);
    const saleEvent = await OutboxEvent.findOne({ where: { eventType: 'keys.delivered', aggregateId: kdSale.id }, transaction: t });
    assert.ok(saleEvent, 'a liberação publica keys.delivered');
    const ranSale = await runEventConsumers(saleEvent, t);
    assert.ok(ranSale.includes('locacao.obrigacoes'));
    const runs = await cadence.q(t, "SELECT r.* FROM marketing.automation_runs r WHERE r.subject_id = :p", { p: buyer });
    assert.equal(runs.length, 1, 'cadência pós-chaves iniciada pelo evento real');
    assert.equal(runs[0].actions_result.length, 4, 'as quatro mensagens da cadência (3/30/90/365 dias)');
    assert.ok(runs[0].actions_result.every((a) => a.status === 'SCHEDULED' && a.purpose === 'POS_VENDA'));

    // Locação: o mesmo evento inicia as obrigações (início = entrega, primeiro vencimento pela periodicidade) e o job cria o ciclo.
    const renter = (await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5VP locatário ${uniqueSuffix()}` }, tenant.userId, t)).id;
    const lease = await releaseFor(t, { contractType: 'LEASE_RESIDENTIAL', role: 'TENANT', personId: renter, inspectionType: 'ENTRY' });
    const { obligation } = await utilitiesService.createUtilityObligation({ ...base(), contractId: lease.contract.id, utilityType: 'WATER', responsibleParty: 'TENANT', dueDay: 10 }, tenant.userId, t);
    const kdLease = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: lease.contract.id, deliveredToPersonId: renter }, tenant.userId, t);
    await keyDeliveriesService.releaseKeyDelivery(kdLease.id, { keysCount: 1, keysIdentification: 'chave da porta', termSignedByPersonId: renter, termEvidenceFileId: lease.term }, tenant.userId, t);
    const leaseEvent = await OutboxEvent.findOne({ where: { eventType: 'keys.delivered', aggregateId: kdLease.id }, transaction: t });
    await runEventConsumers(leaseEvent, t);
    const started = await UtilityObligation.findByPk(obligation.id, { transaction: t });
    assert.ok(started.startsOn && started.nextDueOn, 'obrigação iniciada pela entrega');
    await processLeaseObligations(t, { now: new Date() });
    assert.equal(await LeaseObligationCycle.count({ where: { obligationId: obligation.id, dueOn: started.nextDueOn }, transaction: t }), 1, 'primeiro vencimento vira ciclo');
  });
});
