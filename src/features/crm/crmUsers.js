'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { readManagerPermission, readDefaultLeadOwner } = require('./crm.params');

/**
 * Pessoas do CRM: o responsável da oportunidade (Guia §7 assertResponsibleUser; livro §2 CRMX-006 "Oportunidade aberta precisa
 * de responsável") e a gerência que recebe os escalonamentos (livro §11 "Tarefa vencida escala conforme regra" e §15 "Reclamação
 * grave escala para gerência"). Gerência = membros ativos da empresa cujo papel tem a permissão do parâmetro
 * `crm.gerencia.permissao` (padrão crm:dashboard:read, quem vê o painel gerencial). DI-M3CA-1 e DI-M3CA-5.
 */

const ACTIVE_MEMBER_SQL = `
  SELECT um.user_id
    FROM core.user_memberships um
    JOIN core.users u ON u.id = um.user_id AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
   WHERE um.company_id = :companyId AND um.status = 'ACTIVE' AND um.deleted_at IS NULL`;

async function isActiveMember(userId, companyId, transaction) {
  if (!userId || !companyId) return false;
  const rows = await sequelize.query(`${ACTIVE_MEMBER_SQL} AND um.user_id = :userId LIMIT 1`, {
    replacements: { companyId, userId }, type: QueryTypes.SELECT, transaction,
  });
  return rows.length > 0;
}

/** Gestores da empresa, do membro mais antigo para o mais novo (a ordem decide quem recebe o lead sem responsável). */
async function managerUserIds(tenant, transaction) {
  const permission = await readManagerPermission(tenant, transaction);
  const rows = await sequelize.query(
    `SELECT um.user_id, min(um.created_at) AS since
       FROM core.user_memberships um
       JOIN core.users u ON u.id = um.user_id AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
       JOIN core.role_permissions rp ON rp.role_id = um.role_id
       JOIN core.permissions p ON p.id = rp.permission_id
      WHERE um.company_id = :companyId AND um.status = 'ACTIVE' AND um.deleted_at IS NULL AND p.code = :permission
      GROUP BY um.user_id
      ORDER BY since ASC, um.user_id ASC`,
    { replacements: { companyId: tenant.companyId, permission }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => r.user_id);
}

/** Responsável informado precisa ser usuário ativo com vínculo ativo na empresa da oportunidade. */
async function assertResponsibleUser(userId, companyId, transaction) {
  if (!userId) {
    throw AppError.unprocessable('A oportunidade precisa de um responsável (livro do Marco 3, CRMX-006).', 'OPPORTUNITY_RESPONSIBLE_REQUIRED');
  }
  if (!(await isActiveMember(userId, companyId, transaction))) {
    throw AppError.unprocessable(
      'O responsável precisa ser um usuário ativo desta empresa.',
      'OPPORTUNITY_RESPONSIBLE_INVALID',
      { ownerUserId: userId }
    );
  }
  return userId;
}

/**
 * Responsável de quem não informou: quem cria (usuário autenticado); lead que chega sem usuário (WhatsApp, parceiro) recebe o
 * `crm.lead_automatico.responsavel_padrao`; sem ele configurado (ou inativo), o gestor mais antigo da empresa. Nunca nulo.
 */
async function resolveOwnerUserId({ ownerUserId, actorUserId }, tenant, transaction) {
  if (ownerUserId) return assertResponsibleUser(ownerUserId, tenant.companyId, transaction);
  if (actorUserId && (await isActiveMember(actorUserId, tenant.companyId, transaction))) return actorUserId;
  const configured = await readDefaultLeadOwner(tenant, transaction);
  if (configured && (await isActiveMember(configured, tenant.companyId, transaction))) return configured;
  const [manager] = await managerUserIds(tenant, transaction);
  return assertResponsibleUser(manager || null, tenant.companyId, transaction);
}

module.exports = { isActiveMember, managerUserIds, assertResponsibleUser, resolveOwnerUserId };
