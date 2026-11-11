'use strict';

// Dados de partida do Jurídico para os testes M9-D809 (não é teste). Cada função grava por commit real (a API enxerga) e só deve rodar em banco descartável.
const { withTenantTransaction } = require('../../testHelpers');
const propertiesService = require('../../../src/features/properties/properties.service');
const inspectionsService = require('../../../src/features/legal/inspections.service');
const contractsService = require('../../../src/features/legal/contracts.service');
const contractVersionsService = require('../../../src/features/legal/contractVersions.service');
const contractAmendmentsService = require('../../../src/features/legal/contractAmendments.service');
const noticesService = require('../../../src/features/legal/notices.service');
const { File, BillingSchedule, CollectionCase } = require('../../../src/models');

const sfx = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

const imovel = (t, transaction) => propertiesService.createProperty({ groupId: t.groupId, companyId: t.companyId, title: `QA-M9 Imóvel ${sfx()}`, internalCode: `M9D809-${sfx()}`, propertyType: 'RESIDENTIAL' }, t.userId, transaction);

const arquivo = (t, transaction, nome = 'doc.pdf', mimeType = 'application/pdf') => File.create({
  groupId: t.groupId, companyId: t.companyId, storageKey: `qa-m9/d809/${sfx()}-${nome}`, fileName: nome, mimeType, sizeBytes: 10, uploadedByUserId: t.userId, createdBy: t.userId, updatedBy: t.userId,
}, { transaction });

/** Vistoria concluída e assinada (TENANT), com um item e uma foto pronta para anexar. */
const vistoriaAssinada = (t) => withTenantTransaction(t, async (transaction) => {
  const property = await imovel(t, transaction);
  const inspection = await inspectionsService.createInspection({ groupId: t.groupId, companyId: t.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' }, t.userId, transaction);
  const item = await inspectionsService.addInspectionItem(inspection.id, { itemName: 'Cozinha', condition: 'GOOD' }, t.userId, transaction);
  const file = await arquivo(t, transaction, 'cozinha.jpg', 'image/jpeg');
  await inspectionsService.completeInspection(inspection.id, t.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'qa-m9-assinatura' }, t.userId, transaction);
  return { inspectionId: inspection.id, itemId: item.id, fileId: file.id };
});

/** Contrato de locação com aditivo, notificação e caso de inadimplência (as três fontes da linha do tempo). */
const contratoComLinhaDoTempo = (t) => withTenantTransaction(t, async (transaction) => {
  const contract = await contractsService.createContract({ groupId: t.groupId, companyId: t.companyId, contractType: 'LEASE_RESIDENTIAL', totalValue: 1500 }, t.userId, transaction);
  await contractVersionsService.createContractVersion(contract.id, { content: `Contrato base ${sfx()}`, requireDocument: false }, t.userId, transaction); // Matriz M5: o aditivo referencia a versão base
  const amendment = await contractAmendmentsService.createAmendment(contract.id, { reason: `Reajuste combinado ${sfx()}`, changes: [{ field: 'totalValue', oldValue: 1500, newValue: 1600 }] }, t.userId, transaction);
  const notice = await noticesService.createNotice({ groupId: t.groupId, companyId: t.companyId, contractId: contract.id, channel: 'EMAIL', content: 'Aviso de vencimento próximo' }, t.userId, transaction);
  const schedule = await BillingSchedule.create({
    groupId: t.groupId, companyId: t.companyId, contractId: contract.id, period: '2031-09', dueDate: new Date('2031-09-10'), totalAmount: 1600, paidAmount: 0, balance: 1600, status: 'OPEN',
    generatedAt: new Date(), createdBy: t.userId, updatedBy: t.userId,
  }, { transaction });
  const collection = await CollectionCase.create({
    groupId: t.groupId, companyId: t.companyId, billingScheduleId: schedule.id, contractId: contract.id, status: 'OPEN', overdueSince: '2031-09-15', originalDebtAmount: 1600, currentBalance: 1600,
    createdBy: t.userId, updatedBy: t.userId,
  }, { transaction });
  return { contractId: contract.id, amendmentId: amendment.id, noticeId: notice.id, collectionId: collection.id };
});

/** Contrato com um documento real anexado à versão (o anexo do contrato). */
const contratoComAnexo = (t) => withTenantTransaction(t, async (transaction) => {
  const contract = await contractsService.createContract({ groupId: t.groupId, companyId: t.companyId, contractType: 'LEASE', totalValue: 1000 }, t.userId, transaction);
  const file = await arquivo(t, transaction, 'contrato.pdf');
  await contractVersionsService.createContractVersion(contract.id, { content: 'QA-M9 corpo do contrato', documentFileId: file.id }, t.userId, transaction);
  return { contractId: contract.id, fileId: file.id };
});

module.exports = { vistoriaAssinada, contratoComLinhaDoTempo, contratoComAnexo, imovel, arquivo, sfx };
