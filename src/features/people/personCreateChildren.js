'use strict';

const { PersonContact, PersonDocument, PersonRole, PersonAddress } = require('../../models');
const { assertRoleInCatalog } = require('./personRoles.service');
const { readDocumentParams } = require('./personDocument.settings');

/**
 * Contatos, documentos, papéis e endereço que vêm no corpo do POST /people, gravados na MESMA transação da pessoa (separado de
 * person.service.js para manter um arquivo por responsabilidade). O papel precisa estar no catálogo da empresa (M3-02).
 */
async function createChildren(person, payload, actorUserId, transaction) {
  const { groupId, companyId, contacts, documents } = payload;
  if (Array.isArray(contacts)) {
    for (const contact of contacts) {
      const contactType = contact.contactType || contact.channel;
      const valueNormalized = contact.valueNormalized || contact.value;
      if (!contactType || !valueNormalized) continue;
      await PersonContact.create(
        {
          groupId,
          companyId,
          personId: person.id,
          contactType: String(contactType).toUpperCase(),
          valueNormalized,
          isPrimary: !!contact.isPrimary,
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
    }
  }

  if (Array.isArray(documents)) {
    for (const document of documents) {
      if (!document.documentType || !document.fileId) continue;
      // Documento já verificado na criação: mesma regra da verificação (sem leitura gravada, campos críticos informados).
      const documentStatus = document.verificationStatus ? String(document.verificationStatus).toUpperCase() : 'PENDING';
      let documentExtracted = null;
      if (documentStatus === 'VERIFIED') {
        const { assertReadingAllowsVerification } = require('./personDocuments.service');
        const { camposCriticos } = await readDocumentParams({ groupId, companyId }, transaction);
        const entries = assertReadingAllowsVerification(document.documentType, null, document.manualFields, camposCriticos);
        if (entries.length) {
          documentExtracted = { manualFields: Object.fromEntries(entries), manualFieldsConfirmedBy: actorUserId || null, manualFieldsConfirmedAt: new Date().toISOString() };
        }
      }
      await PersonDocument.create(
        {
          groupId,
          companyId,
          personId: person.id,
          documentType: String(document.documentType).toUpperCase(),
          fileId: document.fileId,
          versionNo: document.versionNo || 1,
          issuedAt: document.issuedAt || null,
          expiresAt: document.expiresAt || null,
          verificationStatus: documentStatus,
          extractedDataJson: documentExtracted,
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
    }
  }

  // `roles` e `addresses` embutidos no payload de criação: a tela de cadastro de contato envia
  // papéis e endereço no mesmo formulário, então criar a pessoa e depois disparar N chamadas a
  // /people/:id/roles e /people/:id/addresses deixaria o cadastro parcialmente escrito se uma
  // delas falhasse. Aqui tudo entra na MESMA transação da Person.
  if (Array.isArray(payload.roles)) {
    for (const role of payload.roles) {
      const roleCode = String(typeof role === 'string' ? role : role.roleCode || '').toUpperCase();
      if (!roleCode) continue;
      await assertRoleInCatalog(roleCode, { groupId, companyId }, transaction); // M3-02: catálogo configurável da empresa
      await PersonRole.create(
        {
          groupId,
          companyId,
          personId: person.id,
          roleCode,
          startsAt: role.startsAt || null,
          endsAt: role.endsAt || null,
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
    }
  }

  const addresses = Array.isArray(payload.addresses)
    ? payload.addresses
    : payload.address
      ? [payload.address]
      : [];
  for (const address of addresses) {
    if (!address) continue;
    await PersonAddress.create(
      {
        groupId,
        companyId,
        personId: person.id,
        zipCode: address.zipCode || null,
        street: address.street || null,
        number: address.number || null,
        complement: address.complement || null,
        neighborhood: address.neighborhood || null,
        city: address.city || null,
        state: address.state || null,
        isCurrent: address.isCurrent !== undefined ? !!address.isCurrent : true,
        validFrom: address.validFrom || null,
        validUntil: address.validUntil || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

}

module.exports = { createChildren };
