'use strict';

const { sequelize, Company, Group } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Correção de segurança (achado no teste adversarial cross-company do Marco de RLS real):
 * "core"."companies" passou a ter RLS própria (`group_id = current_setting('app.group_id')`,
 * ENABLE + FORCE — ver migrations/20260101000001-create-core-companies.js). Antes, a única
 * proteção era `requirePermission` na rota, o que permitia buscar/alterar qualquer empresa de
 * qualquer grupo por id. Toda query aqui roda dentro da `transaction` aberta por
 * `req.withTenantTransaction` (SET LOCAL app.group_id/...), nunca fora dela.
 */
async function createCompany(payload, actorUserId, transaction) {
  const { groupId, name, legalName, taxId, status } = payload;
  if (!groupId || !name) {
    throw AppError.badRequest('Os campos "groupId" e "name" são obrigatórios.', 'COMPANY_VALIDATION');
  }
  const group = await Group.findByPk(groupId, { transaction });
  if (!group) {
    throw AppError.badRequest('Grupo (groupId) informado não existe.', 'COMPANY_GROUP_NOT_FOUND');
  }
  const company = await Company.create(
    {
      groupId,
      name,
      legalName: legalName || null,
      taxId: taxId || null,
      status: status || 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // FIX (achado 18/09/2026 ao trocar pra usuário de banco com privilégio mínimo — RLS real):
  // "audit"."audit_log" tem RLS por company_id. No momento em que uma empresa é CRIADA, o
  // contexto de tenant da transação (SET LOCAL app.company_id) ainda é o da empresa ATUAL do
  // ator — nunca vai bater com company.id (a empresa recém-criada), então o INSERT do próprio
  // evento de criação violava a política de RLS. Sob superuser/BYPASSRLS isso nunca apareceu.
  // Como createCompany é sempre a última operação de sua transação (nenhum código roda depois
  // usando o contexto de tenant original), trocamos o contexto pra empresa recém-criada só
  // para este INSERT — semanticamente correto: o evento "esta empresa foi criada" pertence a
  // ela mesma.
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
  await registrarAuditoria(
    {
      groupId,
      companyId: company.id,
      actorUserId,
      action: 'company.create',
      entityType: 'Company',
      entityId: company.id,
      afterJson: company.toJSON(),
      reason: `Empresa "${company.name}" cadastrada.`,
    },
    transaction
  );

  return company;
}

async function listCompanies(transaction) {
  return Company.findAll({ order: [['created_at', 'DESC']], transaction });
}

async function getCompany(id, transaction) {
  const company = await Company.findByPk(id, { transaction });
  if (!company) throw AppError.notFound('Empresa não encontrada.', 'COMPANY_NOT_FOUND');
  return company;
}

async function updateCompany(id, payload, actorUserId, transaction) {
  const company = await getCompany(id, transaction);
  const beforeJson = company.toJSON();
  const { name, legalName, taxId, status } = payload;
  if (name !== undefined) company.name = name;
  if (legalName !== undefined) company.legalName = legalName;
  if (taxId !== undefined) company.taxId = taxId;
  if (status !== undefined) company.status = status;
  company.updatedBy = actorUserId || null;
  await company.save({ transaction });

  await registrarAuditoria(
    {
      groupId: company.groupId,
      companyId: company.id,
      actorUserId,
      action: 'company.update',
      entityType: 'Company',
      entityId: company.id,
      beforeJson,
      afterJson: company.toJSON(),
      reason: `Empresa "${company.name}" atualizada.`,
    },
    transaction
  );

  return company;
}

async function deleteCompany(id, actorUserId, transaction) {
  const company = await getCompany(id, transaction);
  const beforeJson = company.toJSON();
  company.deletedBy = actorUserId || null;
  await company.save({ transaction });
  await company.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: company.groupId,
      companyId: company.id,
      actorUserId,
      action: 'company.delete',
      entityType: 'Company',
      entityId: company.id,
      beforeJson,
      reason: `Empresa "${company.name}" excluída.`,
    },
    transaction
  );

  return { id };
}

module.exports = { createCompany, listCompanies, getCompany, updateCompany, deleteCompany };
