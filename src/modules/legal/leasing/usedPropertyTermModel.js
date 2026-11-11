'use strict';

const { ContractTemplate, TemplateVersion, ContractTemplateClause, ContractClause, ClauseLibrary } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

/**
 * Termo específico do imóvel usado "conforme modelo jurídico aprovado" (Caderno M5 §7; verificação M5 linha 69).
 *
 * O texto que declara a natureza/estado do imóvel usado deixa de ser constante do código: vem do MODELO de contrato do tipo
 * USED_PROPERTY_DELIVERY (legal.contract_templates), pela versão PUBLICADA vigente (legal.template_versions). Nova versão do texto
 * segue o mecanismo de modelos: mexer no modelo cria a versão DRAFT e publicar exige a alçada jurídica
 * (POST /legal/contract-templates/:id/publish, legal:approve). O termo gravado traz o nome e a versão do modelo no texto (coberto
 * pelo hash) e key_deliveries.term_template_version_id.
 *
 * Versão inicial (DI-M5CT-4): o texto que vigorava no código, de origem CODE_SEED (sem aprovador humano). A migration
 * 20260101015103 a cria para as empresas existentes; empresa criada depois e SEM nenhum modelo do tipo a recebe na primeira
 * entrega de imóvel usado, com auditoria. Empresa que já tem modelo do tipo mas nenhuma versão publicada tem a entrega recusada
 * (409): o jurídico publica a versão em Modelos de contrato.
 */
const MODEL_TYPE = 'USED_PROPERTY_DELIVERY';
const SEED = Object.freeze({
  templateName: 'Termo de entrega de imóvel usado',
  clauseCode: 'TERMO_IMOVEL_USADO',
  clauseTitle: 'Natureza e estado do imóvel usado',
  clauseCategory: 'GENERAL',
  bodyText: 'O imóvel é entregue usado, no estado descrito na vistoria acima, que faz parte deste termo.',
});

async function findPublished(transaction) {
  const templates = await ContractTemplate.findAll({ where: { contractType: MODEL_TYPE, isActive: true }, attributes: ['id', 'name'], transaction });
  if (!templates.length) return { templates, version: null, template: null };
  const version = await TemplateVersion.findOne({
    where: { templateId: templates.map((t) => t.id), status: 'PUBLISHED' }, order: [['published_at', 'DESC'], ['version_number', 'DESC']], transaction,
  });
  return { templates, version, template: version ? templates.find((t) => t.id === version.templateId) : null };
}

async function textOf(version, transaction) {
  const links = await ContractTemplateClause.findAll({ where: { templateVersionId: version.id }, order: [['sort_order', 'ASC']], transaction });
  const clauses = links.length ? await ContractClause.findAll({ where: { id: links.map((l) => l.contractClauseId) }, attributes: ['id', 'bodyText'], transaction }) : [];
  const byId = new Map(clauses.map((c) => [c.id, c.bodyText]));
  return links.map((l) => byId.get(l.contractClauseId)).filter(Boolean).join('\n');
}

/** Versão inicial publicada (origem CODE_SEED) para a empresa do contrato — mesmo conteúdo da migration 20260101015103. */
async function seedModel(contract, actorUserId, transaction) {
  const base = { groupId: contract.groupId, companyId: contract.companyId };
  let clause = await ContractClause.findOne({ where: { code: SEED.clauseCode, isActive: true }, order: [['version_number', 'DESC']], transaction });
  if (!clause) {
    let library = await ClauseLibrary.findOne({ where: { code: SEED.clauseCode }, transaction });
    if (!library) library = await ClauseLibrary.create({ ...base, code: SEED.clauseCode, createdBy: null }, { transaction });
    clause = await ContractClause.create({ ...base, clauseLibraryId: library.id, code: SEED.clauseCode, title: SEED.clauseTitle, bodyText: SEED.bodyText, category: SEED.clauseCategory, versionNumber: 1, isActive: true, createdBy: null }, { transaction });
  }
  const template = await ContractTemplate.create({ ...base, name: SEED.templateName, contractType: MODEL_TYPE, isActive: true, createdBy: null }, { transaction });
  const version = await TemplateVersion.create({ ...base, templateId: template.id, versionNumber: 1, status: 'DRAFT', origin: 'CODE_SEED', createdBy: null }, { transaction });
  await ContractTemplateClause.create({ ...base, contractTemplateId: template.id, contractClauseId: clause.id, templateVersionId: version.id, sortOrder: 0, createdBy: null }, { transaction });
  version.status = 'PUBLISHED';
  version.publishedAt = new Date();
  await version.save({ transaction });
  await registrarAuditoria({
    ...base, actorUserId: actorUserId || null, action: 'legal.contract_template.seed', entityType: 'TemplateVersion', entityId: version.id,
    beforeJson: null, afterJson: { templateId: template.id, versionNumber: 1, origin: 'CODE_SEED', clauseCode: SEED.clauseCode },
    reason: `Modelo "${SEED.templateName}" criado na versão 1 com o texto que vigorava no sistema (primeira entrega de imóvel usado da empresa).`,
  }, transaction);
  return { template, version };
}

/**
 * Modelo vigente do termo do imóvel usado: { templateId, templateName, templateVersionId, versionNumber, origin, text }.
 * `seedIfMissing`: na liberação (grava); na prévia (só leitura) devolve o texto da versão inicial marcado como `pending`.
 */
async function resolveUsedPropertyTermModel(contract, { actorUserId = null, seedIfMissing = false } = {}, transaction) {
  let found = await findPublished(transaction);
  if (!found.version && !found.templates.length) {
    if (!seedIfMissing) return { pending: true, templateName: SEED.templateName, versionNumber: 1, text: SEED.bodyText, templateVersionId: null };
    const seeded = await seedModel(contract, actorUserId, transaction);
    found = { template: seeded.template, version: seeded.version };
  }
  if (!found.version) {
    throw AppError.conflict(
      'Não há modelo jurídico aprovado para o termo do imóvel usado: publique a versão do modelo "Termo de entrega de imóvel usado" em Modelos de contrato (alçada jurídica).',
      'LEGAL_USED_PROPERTY_TERM_MODEL_NOT_PUBLISHED'
    );
  }
  const text = await textOf(found.version, transaction);
  if (!text.trim()) throw AppError.conflict('O modelo publicado do termo do imóvel usado está sem texto.', 'LEGAL_USED_PROPERTY_TERM_MODEL_NOT_PUBLISHED');
  return {
    pending: false, templateId: found.template.id, templateName: found.template.name, templateVersionId: found.version.id,
    versionNumber: found.version.versionNumber, origin: found.version.origin, text,
  };
}

module.exports = { MODEL_TYPE, SEED, resolveUsedPropertyTermModel };
