'use strict';

const {
  Property,
  PropertyOwner,
  PropertyOffer,
  PropertyMedia,
  PropertyDocument,
  PropertyInternalOccurrence,
  Opportunity,
  Visit,
  Proposal,
  Contract,
  AuditLog,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');

/**
 * propertyMerge.service.js — item 1 do ciclo de auditoria externa Marco 3 ("merge de Imóvel
 * não existe — implemente um fluxo equivalente pro Imóvel").
 *
 * Contrato bruto confirmado (Caderno Pessoas/Imóveis/CRM/Radar §30 "Merge seguro de
 * Imóveis"):
 *   "Mesmo princípio de Pessoas, porém ofertas, históricos de preço, proprietários, mídias,
 *    contratos e processos precisam ser avaliados. Dois imóveis com matrículas efetivamente
 *    distintas não podem ser mesclados apenas por endereço semelhante."
 * E DB-BLIND-005 ("Merge de cadastros"): "Persons e Properties terão fluxo de merge... o
 * registro absorvido fica MERGED com canonical_id; histórico e IDs [preservados]."
 *
 * DIVERGÊNCIAS DOCUMENTADAS (migrations bloqueadas nesta sessão — mesma credencial de
 * `nayara_migration` rejeitada, sem acesso para corrigir):
 *   - "real_estate"."properties" NÃO tem coluna `merged_into_id`/`status='MERGED'` dedicada
 *     (schema físico atual só tem publication_status/availability_status, sem valor MERGED).
 *     Substituto SEM DDL: `availability_status='WITHDRAWN'` (o imóvel absorvido sai de
 *     circulação — mais próximo do enum existente) + `publication_status='INACTIVE'` +
 *     `attributes_json.mergeStatus='MERGED'` / `attributes_json.mergedIntoPropertyId` (coluna
 *     JSONB já existente, flexível) guardam o estado de merge de forma consultável.
 *   - Não existe tabela "merge_cases" dedicada (mesma lacuna do merge de Pessoas) — o
 *     merge_case é um audit_log `action='property.merge_case.opened'`.
 *
 * Fluxo (mesmo princípio do merge de Pessoas, personMerge.service.js):
 *   1. Abre merge_case (audit_log) ANTES de qualquer checagem.
 *   2. Bloqueia se as matrículas (registry_number) de ambos os imóveis estiverem preenchidas
 *      E forem diferentes — "Dois imóveis com matrículas efetivamente distintas não podem ser
 *      mesclados apenas por endereço semelhante."
 *   3. Snapshot completo de ambos os imóveis.
 *   4. Remapeia ofertas (e por consequência o histórico de preço, que referencia offer_id),
 *      proprietários, mídias, documentos, ocorrências internas, oportunidades/visitas/
 *      propostas do CRM e contratos jurídicos vinculados ao imóvel absorvido.
 *   5. Marca o imóvel absorvido como MERGED (ver substituto acima) preservando mídias/
 *      documentos (nunca sobrescreve arquivo — apenas remapeia o property_id).
 *   6. Publica property.merged com mapa de referências remapeadas + audit log.
 *   7. Reversão só por processo técnico supervisionado (reversePropertyMergeSupervised).
 */
async function assertNoDistinctRegistryNumbers(canonical, absorbed) {
  if (canonical.registryNumber && absorbed.registryNumber && canonical.registryNumber !== absorbed.registryNumber) {
    throw AppError.unprocessable(
      'Merge bloqueado: os dois imóveis têm matrículas preenchidas e efetivamente distintas — não podem ser mesclados apenas por endereço semelhante.',
      'PROPERTY_MERGE_CONFLICT_DISTINCT_REGISTRY',
      { canonicalRegistryNumber: canonical.registryNumber, absorbedRegistryNumber: absorbed.registryNumber }
    );
  }
}

async function mergeProperties(canonicalId, absorbedId, actorUserId, transaction) {
  if (!absorbedId) {
    throw AppError.badRequest('O campo "absorbedId" é obrigatório.', 'PROPERTY_MERGE_VALIDATION');
  }
  if (canonicalId === absorbedId) {
    throw AppError.badRequest('"absorbedId" não pode ser igual ao id canônico.', 'PROPERTY_MERGE_VALIDATION');
  }

  // Mesmo lock pessimista do merge de Pessoas — evita merges concorrentes do mesmo absorvido
  // para canônicos diferentes deixarem FKs remapeadas de forma inconsistente.
  const canonical = await Property.findByPk(canonicalId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!canonical) throw AppError.notFound('Imóvel canônico não encontrado.', 'PROPERTY_NOT_FOUND');

  const absorbed = await Property.findByPk(absorbedId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!absorbed) throw AppError.notFound('Imóvel absorvido não encontrado.', 'PROPERTY_NOT_FOUND');

  const absorbedAttributes = absorbed.attributesJson || {};
  if (absorbedAttributes.mergeStatus === 'MERGED') {
    throw AppError.unprocessable('Este imóvel já foi fundido anteriormente.', 'PROPERTY_ALREADY_MERGED');
  }

  await AuditLog.create(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      userId: actorUserId || null,
      action: 'property.merge_case.opened',
      entityType: 'Property',
      entityId: canonicalId,
      beforeJson: null,
      afterJson: { canonicalId, absorbedId, detectedAt: new Date().toISOString() },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await assertNoDistinctRegistryNumbers(canonical, absorbed);

  const beforeJson = { canonical: canonical.toJSON(), absorbed: absorbed.toJSON() };

  const remappedReferences = {};
  async function remapAndCount(key, Model, where) {
    if (!Model) return;
    const [count] = await Model.update({ propertyId: canonicalId }, { where, transaction });
    remappedReferences[key] = count;
  }

  // Ofertas primeiro — PropertyPriceHistory referencia offer_id, não property_id diretamente,
  // então o histórico de preço "segue" a oferta automaticamente, sem precisar de um UPDATE
  // próprio (preserva o histórico íntegro, nunca sobrescrito).
  await remapAndCount('real_estate.property_offers', PropertyOffer, { propertyId: absorbedId });
  await remapAndCount('real_estate.property_owners', PropertyOwner, { propertyId: absorbedId });
  await remapAndCount('real_estate.property_media', PropertyMedia, { propertyId: absorbedId });
  await remapAndCount('real_estate.property_documents', PropertyDocument, { propertyId: absorbedId });
  await remapAndCount('real_estate.property_internal_occurrences', PropertyInternalOccurrence, { propertyId: absorbedId });
  await remapAndCount('crm.opportunities', Opportunity, { propertyId: absorbedId });
  await remapAndCount('crm.visits', Visit, { propertyId: absorbedId });
  await remapAndCount('crm.proposals', Proposal, { propertyId: absorbedId });
  await remapAndCount('legal.contracts', Contract, { propertyId: absorbedId });

  // Substituto sem DDL para "status=MERGED"/"merged_into_id" — ver nota de divergência no
  // cabeçalho do módulo.
  absorbed.availabilityStatus = 'WITHDRAWN';
  absorbed.publicationStatus = 'INACTIVE';
  absorbed.attributesJson = {
    ...absorbedAttributes,
    mergeStatus: 'MERGED',
    mergedIntoPropertyId: canonicalId,
    mergedAt: new Date().toISOString(),
  };
  absorbed.updatedBy = actorUserId || null;
  await absorbed.save({ transaction });

  await publishDomainEvent(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      aggregateType: 'Property',
      aggregateId: canonical.id,
      eventType: 'property.merged',
      payload: { canonicalId: canonical.id, absorbedId: absorbed.id, remappedReferences },
      idempotencyKey: `property.merged:${canonical.id}:${absorbed.id}`,
    },
    transaction
  );

  await AuditLog.create(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      userId: actorUserId || null,
      action: 'property.merge',
      entityType: 'Property',
      entityId: canonicalId,
      beforeJson,
      afterJson: { canonicalId, absorbedId, mergeStatus: 'MERGED', remappedReferences },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return { canonicalId, absorbedId, status: 'MERGED', remappedReferences };
}

/**
 * reversePropertyMergeSupervised — mesmo princípio de reverseMergeSupervised (Pessoas): não é
 * um "desfazer" de botão comum, exige `reason` com justificativa real.
 */
async function reversePropertyMergeSupervised(canonicalId, absorbedId, reason, actorUserId, transaction) {
  if (!reason || String(reason).trim().length < 10) {
    throw AppError.badRequest(
      'Reversão de merge de imóvel exige "reason" com justificativa real (mínimo 10 caracteres) — processo técnico supervisionado, não um botão comum.',
      'PROPERTY_MERGE_REVERSAL_REASON_REQUIRED'
    );
  }

  const absorbed = await Property.findByPk(absorbedId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!absorbed) throw AppError.notFound('Imóvel absorvido não encontrado.', 'PROPERTY_NOT_FOUND');

  const attrs = absorbed.attributesJson || {};
  if (attrs.mergeStatus !== 'MERGED' || attrs.mergedIntoPropertyId !== canonicalId) {
    throw AppError.unprocessable(
      'Este imóvel não está fundido no canônico informado — não há merge para reverter.',
      'PROPERTY_MERGE_REVERSAL_NOT_MERGED'
    );
  }

  const beforeJson = { absorbed: absorbed.toJSON() };

  absorbed.availabilityStatus = 'AVAILABLE';
  absorbed.publicationStatus = 'DRAFT';
  const { mergeStatus, mergedIntoPropertyId, mergedAt, ...restAttrs } = attrs;
  absorbed.attributesJson = restAttrs;
  absorbed.updatedBy = actorUserId || null;
  await absorbed.save({ transaction });

  await AuditLog.create(
    {
      groupId: absorbed.groupId,
      companyId: absorbed.companyId,
      userId: actorUserId || null,
      action: 'property.merge.reversed_supervised',
      entityType: 'Property',
      entityId: absorbedId,
      beforeJson,
      afterJson: { canonicalId, absorbedId, reason: String(reason) },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return { canonicalId, absorbedId, status: 'REVERSED' };
}

module.exports = { mergeProperties, reversePropertyMergeSupervised };
