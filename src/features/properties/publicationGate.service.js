'use strict';

const { Property, PropertyOffer } = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPropertyPublished, publishPropertyPublicSourceChanged } = require('./propertyEvents.service');
const { buildPublicationFacts } = require('./publicationFacts');
const { FIELD_CATALOG } = require('./propertyPublication.settings');

/**
 * Gate ÚNICO de publicação do imóvel (livro do Marco 3 §7 e CRMX-012; Guia §6 `assertPublishable`). Toda transição para
 * PUBLISHED passa por aqui — POST /offers/:id/publish, PATCH /properties/:id e POST /properties (verificação independente de
 * 11/11/2026, M3-09/CAD-07: a criação já publicada e a mídia aprovada pelo corpo contornavam o gate). A importação do sistema
 * antigo e a alteração em massa não gravam publication_status (test/m3im.gatePublicacao.http.test.js confere).
 *
 * Cada checagem é decidida pelo Motor de Regras (fail-closed: sem regra publicada, não publica):
 *   oferta ativa -> REG-IMO-001 (vídeo aprovado) -> REG-IMO-PHOTO-MIN (fotos aprovadas) -> REG-IMO-DOCS-001 (documentos
 *   configurados, com arquivo) -> REG-IMO-FIELDS-001 (campos obrigatórios configurados).
 */
const GATE_CODES = Object.freeze([
  'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER',
  'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001',
  'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN',
  'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001',
  'PROPERTY_PUBLISH_BLOCKED_REG_IMO_FIELDS_001',
]);

async function decide(code, facts, tenant, transaction) {
  return evaluateRule(code, facts, tenant, { transaction });
}

async function assertActiveOffer(property, offer, transaction) {
  if (offer) {
    if (offer.propertyId !== property.id || offer.status !== 'ACTIVE') {
      throw AppError.conflict('Só é possível publicar a partir de uma oferta ativa.', 'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER');
    }
    return;
  }
  const active = await PropertyOffer.count({ where: { propertyId: property.id, status: 'ACTIVE' }, transaction });
  if (active === 0) {
    throw AppError.conflict('Não é possível publicar um imóvel sem nenhuma oferta ativa vinculada.', 'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER');
  }
}

/** Lança o erro de negócio da primeira checagem que falhar; devolve os fatos quando tudo passa. */
async function assertPublishable(property, tenant, transaction, { offer } = {}) {
  await assertActiveOffer(property, offer, transaction);
  const facts = await buildPublicationFacts(property, tenant, transaction);

  const video = await decide('REG-IMO-001', { hasVideo: facts.media.hasVideo }, tenant, transaction);
  if (video.decision !== 'APPLY') {
    throw AppError.unprocessable('Publicação bloqueada: vídeo obrigatório ausente (só conta vídeo com arquivo e qualidade aprovada).', 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001', { ruleDecision: video.decision, reason: video.reason });
  }
  const photos = await decide('REG-IMO-PHOTO-MIN', { approvedPhotoCount: facts.media.approvedPhotoCount }, tenant, transaction);
  if (photos.decision !== 'APPLY') {
    throw AppError.unprocessable('Publicação bloqueada: quantidade mínima de fotos aprovadas não atingida.', 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN', { ruleDecision: photos.decision, reason: photos.reason, approvedPhotoCount: facts.media.approvedPhotoCount });
  }
  const docs = await decide('REG-IMO-DOCS-001', { hasRequiredDocuments: facts.documents.hasRequiredDocuments }, tenant, transaction);
  if (docs.decision !== 'APPLY') {
    const missing = facts.documents.missingDocumentTypes;
    throw AppError.unprocessable(`Publicação bloqueada: documentos obrigatórios ausentes${missing.length ? ` (${missing.join(', ')})` : ''}. O documento só conta com o arquivo anexado.`, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001', { ruleDecision: docs.decision, reason: docs.reason, missingDocTypes: missing, requiredDocTypes: facts.documents.requiredDocumentTypes });
  }
  const fields = await decide('REG-IMO-FIELDS-001', { hasRequiredFields: facts.fields.hasRequiredFields }, tenant, transaction);
  if (fields.decision !== 'APPLY') {
    const missing = facts.fields.missingFields;
    throw AppError.unprocessable(`Publicação bloqueada: campos obrigatórios não preenchidos${missing.length ? ` (${missing.map((f) => FIELD_CATALOG[f] || f).join('; ')})` : ''}.`, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_FIELDS_001', { ruleDecision: fields.decision, reason: fields.reason, missingFields: missing, requiredFields: facts.fields.requiredFields });
  }
  return facts;
}

/** Único ponto do código que grava PUBLISHED: passa o gate, grava, audita (antes/depois) e emite property.published. */
async function publishProperty(property, tenant, actorUserId, transaction, { offer, source }) {
  const beforeJson = property.toJSON();
  const facts = await assertPublishable(property, tenant, transaction, { offer });
  property.publicationStatus = 'PUBLISHED';
  property.updatedBy = actorUserId || null;
  await property.save({ transaction });
  await registrarAuditoria({
    groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.publish', entityType: 'Property', entityId: property.id,
    beforeJson, afterJson: { ...property.toJSON(), publicationFacts: facts },
    reason: `Imóvel "${property.title}" publicado pelo gate (${source}).`,
  }, transaction);
  if (beforeJson.publicationStatus !== 'PUBLISHED') await publishPropertyPublished(property, transaction);
  return facts;
}

/**
 * Imóvel já publicado que deixou de cumprir o gate (vídeo apagado ou recusado, foto recusada, documento apagado, campo
 * esvaziado, proprietário removido): volta para INACTIVE na mesma transação, auditado, em vez de continuar publicado.
 */
async function revalidatePublication(propertyId, tenant, actorUserId, transaction, motivo) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property || property.publicationStatus !== 'PUBLISHED') return null;
  try {
    await assertPublishable(property, tenant, transaction);
    return null;
  } catch (err) {
    if (!(err instanceof AppError) || !GATE_CODES.includes(err.code)) throw err;
    const beforeJson = property.toJSON();
    property.publicationStatus = 'INACTIVE';
    property.updatedBy = actorUserId || null;
    await property.save({ transaction });
    await registrarAuditoria({
      groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.auto_unpublish', entityType: 'Property', entityId: property.id,
      beforeJson, afterJson: { ...property.toJSON(), gateCode: err.code },
      reason: `Imóvel "${property.title}" despublicado automaticamente: ${motivo}; deixou de cumprir o gate (${err.code}).`,
    }, transaction);
    // O read model público (site e portais) recalcula pelo evento e tira o imóvel do ar.
    await publishPropertyPublicSourceChanged(property, transaction);
    return err.code;
  }
}

module.exports = { assertPublishable, publishProperty, revalidatePublication, GATE_CODES };
