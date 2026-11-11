'use strict';

const { Person, ContractParty } = require('../../../../models');
const AppError = require('../../../../utils/AppError');

/**
 * Signatários do pedido de envelope (M9-D236): nome, e-mail principal e papel no contrato de cada pessoa. O e-mail é opcional para o sandbox; o adapter de um fornecedor
 * real recusa quem não tem e-mail cadastrado. Toda pessoa precisa existir na empresa.
 */
async function loadSigners(signerPersonIds, contractId, transaction) {
  const pessoas = await Person.findAll({ where: { id: signerPersonIds }, include: [{ association: 'contacts' }], transaction });
  const porId = new Map(pessoas.map((p) => [p.id, p]));
  const partes = await ContractParty.findAll({ where: { contractId }, transaction });
  return signerPersonIds.map((personId) => {
    const pessoa = porId.get(personId);
    if (!pessoa) throw AppError.notFound(`Pessoa ${personId} não encontrada para montar signatário do envelope.`, 'LEGAL_SIGNATURE_PERSON_NOT_FOUND');
    const contatos = pessoa.contacts || [];
    const email = contatos.find((c) => c.contactType === 'EMAIL' && c.isPrimary) || contatos.find((c) => c.contactType === 'EMAIL');
    const parte = partes.find((p) => p.personId === personId);
    return { personId, name: pessoa.legalName, email: email ? String(email.valueNormalized).toLowerCase() : undefined, role: parte ? parte.partyRole : undefined };
  });
}

module.exports = { loadSigners };
