'use strict';

const {
  Person,
  PersonRole,
  PersonContact,
  PersonDocument,
  PersonAddress,
  CommunicationConsent,
  PropertyOwner,
  Opportunity,
  Visit,
  PropertyRadar,
  Message,
  ContractParty,
  Signature,
  BankAccount,
  OwnerRepass,
  MaintenanceCase,
  AuditLog,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { publishPersonMerged } = require('./personEvents.service');

/**
 * mergePersons — POST /people/:id/merge ("Merge controlado.").
 *
 * Fluxo confirmado pelo Caderno (DedupService/MergeService):
 *   1. canonicalId (rota :id) absorve absorbedId (body).
 *   2. roda dentro de uma transação (a mesma `transaction` já aberta por
 *      req.withTenantTransaction, recebida como parâmetro).
 *   3. bloqueia com 422 se houver conflito relevante.
 *   4. remapeia as FKs permitidas do absorvido para o canônico.
 *   5. marca a pessoa absorvida com status='MERGED' e merged_into_id=canonicalId.
 *   6. publica person.merged via o motor de eventos (outbox).
 *   7. registra em audit.audit_log.
 *
 * Checagem de conflito (nesta implementação inicial): bloqueia se ambas as pessoas tiverem
 * tax_id_normalized preenchido E diferente entre si (conflito de identidade — não faz sentido
 * fundir dois CPFs/CNPJs distintos). Outras checagens do Caderno (contratos ativos
 * incompatíveis, restrição jurídica) ficam para iteração futura: dependem de módulos
 * (legal.contracts, LegalCase) cujo estado de "incompatibilidade" não está definido aqui e cuja
 * regra de negócio não foi confirmada pelo documento-fonte para este merge especificamente.
 *
 * Remapeamento de FKs — cobre TODA tabela do schema físico atual com uma coluna apontando para
 * people.persons (auditado em src/models/*.js, não só os módulos com feature/CRUD já
 * construído): person_roles, person_contacts, person_documents, person_addresses,
 * communication_consents, real_estate.property_owners, crm.opportunities, crm.visits,
 * crm.property_radars, crm.messages, legal.contract_parties, legal.signatures,
 * finance.bank_accounts (owner_person_id), finance.owner_repasses (owner_person_id),
 * construction.maintenance_cases (opened_by_person_id). A coluna existir no banco já obriga o
 * remapeamento, independente de já existir uma rota HTTP para aquele módulo — senão o merge
 * deixa dado órfão apontando para a pessoa MERGED. Se um módulo novo adicionar uma FK de pessoa
 * no futuro, ela precisa ser adicionada aqui também.
 */
async function mergePersons(canonicalId, absorbedId, actorUserId, transaction) {
  if (!absorbedId) {
    throw AppError.badRequest('O campo "absorbedId" é obrigatório.', 'PERSON_MERGE_VALIDATION');
  }
  if (canonicalId === absorbedId) {
    throw AppError.badRequest('"absorbedId" não pode ser igual ao id canônico.', 'PERSON_MERGE_VALIDATION');
  }

  const canonical = await Person.findByPk(canonicalId, { transaction });
  if (!canonical) throw AppError.notFound('Pessoa canônica não encontrada.', 'PERSON_NOT_FOUND');

  const absorbed = await Person.findByPk(absorbedId, { transaction });
  if (!absorbed) throw AppError.notFound('Pessoa absorvida não encontrada.', 'PERSON_NOT_FOUND');

  if (absorbed.status === 'MERGED') {
    throw AppError.unprocessable('A pessoa absorvida já foi fundida anteriormente.', 'PERSON_ALREADY_MERGED');
  }

  if (canonical.taxIdNormalized && absorbed.taxIdNormalized && canonical.taxIdNormalized !== absorbed.taxIdNormalized) {
    throw AppError.unprocessable(
      'Conflito de identidade: as duas pessoas têm documentos (CPF/CNPJ) preenchidos e diferentes entre si.',
      'PERSON_MERGE_CONFLICT',
      { canonicalTaxId: canonical.taxIdNormalized, absorbedTaxId: absorbed.taxIdNormalized }
    );
  }

  const beforeJson = { canonicalId: canonical.id, absorbedId: absorbed.id, absorbedStatus: absorbed.status };

  // Remapeamento de FKs — todas as linhas do absorvido passam a apontar para o canônico.
  await PersonRole.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  await PersonContact.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  await PersonDocument.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  await PersonAddress.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  await CommunicationConsent.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  if (PropertyOwner) {
    await PropertyOwner.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  // crm.opportunities / crm.visits / crm.property_radars já existem e referenciam person_id
  // diretamente (Marco 3, não é módulo futuro) — remapear é obrigatório para o merge não deixar
  // oportunidades/visitas/radares órfãos apontando para a pessoa MERGED.
  if (Opportunity) {
    await Opportunity.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  if (Visit) {
    await Visit.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  if (PropertyRadar) {
    await PropertyRadar.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  if (Message) {
    await Message.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  // Tabelas com FK de pessoa já existentes no schema físico (Marco 1&2), ainda sem
  // feature/CRUD próprio construído — a coluna existe no banco, então precisa ser remapeada
  // igual, senão o merge deixa dado órfão silenciosamente.
  if (ContractParty) {
    await ContractParty.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  if (Signature) {
    await Signature.update({ personId: canonicalId }, { where: { personId: absorbedId }, transaction });
  }
  if (BankAccount) {
    await BankAccount.update({ ownerPersonId: canonicalId }, { where: { ownerPersonId: absorbedId }, transaction });
  }
  if (OwnerRepass) {
    await OwnerRepass.update({ ownerPersonId: canonicalId }, { where: { ownerPersonId: absorbedId }, transaction });
  }
  if (MaintenanceCase) {
    await MaintenanceCase.update({ openedByPersonId: canonicalId }, { where: { openedByPersonId: absorbedId }, transaction });
  }

  absorbed.status = 'MERGED';
  absorbed.mergedIntoId = canonicalId;
  absorbed.updatedBy = actorUserId || null;
  await absorbed.save({ transaction });

  await publishPersonMerged(canonical, absorbed, transaction);

  // audit.audit_log — trilha de auditoria append-only (AuditLog model já existe; escrita
  // direta aqui pois não há um helper reusável de auditoria compartilhado pelas outras
  // features ainda — ver observação no relatório de entrega).
  await AuditLog.create(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      userId: actorUserId || null,
      action: 'person.merge',
      entityType: 'Person',
      entityId: canonicalId,
      beforeJson,
      afterJson: { canonicalId, absorbedId, absorbedStatus: 'MERGED' },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return { canonicalId, absorbedId, status: 'MERGED' };
}

module.exports = { mergePersons };
