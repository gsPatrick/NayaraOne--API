'use strict';

const { TemplateVersion, ContractTemplateClause, ContractClause, ClauseLibrary, User } = require('../../../../models');
const { getTemplate } = require('./template.service');

/**
 * Leitura completa do modelo e da biblioteca (Caderno M5 §6, JUR-002): o modelo traz o responsável jurídico, as
 * versões (número, situação, publicador, data) e as cláusulas de cada versão; a lista de cláusulas traz o
 * responsável jurídico da cláusula (legal.clause_library).
 */
async function usersById(ids, transaction) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await User.findAll({ where: { id: unique }, attributes: ['id', 'name'], transaction });
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.name }]));
}

async function getTemplateDetail(id, transaction) {
  const template = await getTemplate(id, transaction);
  const versions = await TemplateVersion.findAll({ where: { templateId: template.id }, order: [['version_number', 'ASC']], transaction });
  const links = await ContractTemplateClause.findAll({ where: { contractTemplateId: template.id }, order: [['sort_order', 'ASC']], transaction });
  const clauses = links.length ? await ContractClause.findAll({ where: { id: [...new Set(links.map((l) => l.contractClauseId))] }, transaction }) : [];
  const clauseById = new Map(clauses.map((c) => [c.id, c]));
  const people = await usersById([template.legalResponsibleUserId, ...versions.flatMap((v) => [v.legalResponsibleUserId, v.publishedBy])], transaction);
  const versionsOut = versions.map((v) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    legalResponsible: people.get(v.legalResponsibleUserId) || null,
    publishedBy: people.get(v.publishedBy) || null,
    publishedAt: v.publishedAt,
    origin: v.origin || 'USER', // CODE_SEED = versão inicial com o texto que vigorava no sistema (termo do imóvel usado, migration 20260101015103)
    clauses: links.filter((l) => l.templateVersionId === v.id).map((l) => {
      const c = clauseById.get(l.contractClauseId);
      return { sortOrder: l.sortOrder, contractClauseId: l.contractClauseId, code: c ? c.code : null, title: c ? c.title : null, versionNumber: c ? c.versionNumber : null, isActive: c ? c.isActive : null };
    }),
  }));
  const published = [...versionsOut].reverse().find((v) => v.status === 'PUBLISHED') || null;
  const draft = versionsOut.find((v) => v.status === 'DRAFT') || null;
  return {
    ...template.toJSON(),
    legalResponsible: people.get(template.legalResponsibleUserId) || null,
    publishedVersion: published,
    draftVersion: draft,
    clauses: (draft || published || { clauses: [] }).clauses,
    versions: versionsOut,
  };
}

/** Cláusulas com o responsável jurídico da biblioteca (id e nome). */
async function withLegalResponsible(clauses, transaction) {
  const libIds = [...new Set(clauses.map((c) => c.clauseLibraryId).filter(Boolean))];
  const libs = libIds.length ? await ClauseLibrary.findAll({ where: { id: libIds }, transaction }) : [];
  const libById = new Map(libs.map((l) => [l.id, l]));
  const people = await usersById(libs.map((l) => l.legalResponsibleUserId), transaction);
  return clauses.map((c) => {
    const lib = libById.get(c.clauseLibraryId);
    return { ...c.toJSON(), legalResponsibleUserId: lib ? lib.legalResponsibleUserId : null, legalResponsible: lib ? people.get(lib.legalResponsibleUserId) || null : null };
  });
}

module.exports = { getTemplateDetail, withLegalResponsible };
