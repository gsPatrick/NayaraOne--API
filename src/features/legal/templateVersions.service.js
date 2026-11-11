'use strict';

const { TemplateVersion, ContractTemplateClause } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Versões do modelo de contrato (Caderno M5 §4 legal.template_versions; §6 "Modelo publicado não é editado;
 * nova versão é criada"; §19 "Alterar modelo/cláusula | Governança/versionamento").
 *  - Vínculos de cláusula pertencem a uma versão. Só a versão DRAFT recebe vínculo (gatilho do banco).
 *  - Mexer num modelo cuja versão vigente está PUBLISHED cria a próxima versão DRAFT com cópia dos vínculos.
 *  - Publicar (rota dedicada, legal:approve) leva DRAFT -> PUBLISHED e a anterior -> SUPERSEDED.
 *  - Gerar versão de contrato a partir de uma DRAFT a congela (publica) na hora: o que entrou num contrato
 *    nunca mais muda e a versão do contrato guarda o template_version_id dela. (O livro não diz que só modelo
 *    publicado gera contrato; o comportamento atual — qualquer modelo gera — foi mantido com essa garantia.)
 */
const latestVersion = (templateId, transaction) => TemplateVersion.findOne({ where: { templateId }, order: [['version_number', 'DESC']], transaction });

async function createInitialVersion(template, actorUserId, transaction) {
  return TemplateVersion.create({
    groupId: template.groupId, companyId: template.companyId, templateId: template.id, versionNumber: 1, status: 'DRAFT',
    legalResponsibleUserId: template.legalResponsibleUserId || actorUserId || null, createdBy: actorUserId || null,
  }, { transaction });
}

/** A versão DRAFT do modelo (cria a próxima, copiando os vínculos da vigente, quando a vigente já foi publicada). */
async function getEditableVersion(template, actorUserId, transaction) {
  const latest = await latestVersion(template.id, transaction);
  if (!latest) return createInitialVersion(template, actorUserId, transaction);
  if (latest.status === 'DRAFT') return latest;
  const draft = await TemplateVersion.create({
    groupId: template.groupId, companyId: template.companyId, templateId: template.id, versionNumber: latest.versionNumber + 1, status: 'DRAFT',
    legalResponsibleUserId: template.legalResponsibleUserId || latest.legalResponsibleUserId || actorUserId || null, createdBy: actorUserId || null,
  }, { transaction });
  const links = await ContractTemplateClause.findAll({ where: { templateVersionId: latest.id }, order: [['sort_order', 'ASC']], transaction });
  for (const l of links) {
    await ContractTemplateClause.create({
      groupId: l.groupId, companyId: l.companyId, contractTemplateId: l.contractTemplateId, contractClauseId: l.contractClauseId,
      templateVersionId: draft.id, sortOrder: l.sortOrder, createdBy: actorUserId || null,
    }, { transaction });
  }
  return draft;
}

/** Versão usada para montar o documento: a DRAFT em edição, se houver; senão a última publicada. */
async function getCurrentVersion(templateId, transaction) {
  const draft = await TemplateVersion.findOne({ where: { templateId, status: 'DRAFT' }, transaction });
  if (draft) return draft;
  const published = await TemplateVersion.findOne({ where: { templateId, status: 'PUBLISHED' }, order: [['version_number', 'DESC']], transaction });
  if (!published) throw AppError.conflict('O modelo não tem versão para gerar documento.', 'LEGAL_TEMPLATE_VERSION_NOT_FOUND');
  return published;
}

async function publishVersion(template, version, actorUserId, transaction) {
  if (!actorUserId) throw AppError.forbidden('Publicar o modelo exige um usuário identificado.', 'LEGAL_TEMPLATE_PUBLISHER_REQUIRED');
  if (!version.legalResponsibleUserId && !template.legalResponsibleUserId) {
    throw AppError.badRequest('O modelo precisa de responsável jurídico antes de ser publicado.', 'LEGAL_TEMPLATE_RESPONSIBLE_REQUIRED');
  }
  const links = await ContractTemplateClause.count({ where: { templateVersionId: version.id }, transaction });
  if (links === 0) throw AppError.conflict('Modelo sem cláusulas não é publicado.', 'LEGAL_TEMPLATE_EMPTY');
  await TemplateVersion.update({ status: 'SUPERSEDED' }, { where: { templateId: template.id, status: 'PUBLISHED' }, transaction });
  const before = { status: version.status };
  version.status = 'PUBLISHED';
  version.publishedBy = actorUserId;
  version.publishedAt = new Date();
  await version.save({ transaction });
  await registrarAuditoria({
    groupId: template.groupId, companyId: template.companyId, actorUserId, action: 'legal.contract_template.publish', entityType: 'TemplateVersion', entityId: version.id,
    beforeJson: before, afterJson: { status: 'PUBLISHED', versionNumber: version.versionNumber, legalResponsibleUserId: version.legalResponsibleUserId },
    reason: `Modelo "${template.name}" publicado na versão ${version.versionNumber}.`,
  }, transaction);
  return version;
}

/** Publicação explícita (rota de governança). */
async function publishTemplate(template, actorUserId, transaction) {
  const draft = await TemplateVersion.findOne({ where: { templateId: template.id, status: 'DRAFT' }, transaction });
  if (!draft) throw AppError.conflict('Não há versão em rascunho do modelo para publicar.', 'LEGAL_TEMPLATE_NOTHING_TO_PUBLISH');
  return publishVersion(template, draft, actorUserId, transaction);
}

/** Congela a versão DRAFT usada na geração de um contrato (publicação na primeira geração). */
async function freezeOnUse(template, version, actorUserId, transaction) {
  if (version.status === 'DRAFT') return publishVersion(template, version, actorUserId, transaction);
  return version;
}

module.exports = { createInitialVersion, getEditableVersion, getCurrentVersion, publishTemplate, freezeOnUse, latestVersion };
