'use strict';

const { Notification } = require('../../../models');
const { recordError } = require('../errors');
const { ERROR_CODE, SEVERITY_MAP, FAILED_MESSAGE } = require('./depaudit.constants');
const { advisoryRefId } = require('./depaudit.evaluate');

const PERMISSAO_AVISO = 'integration:manage';

async function usersWithPermission(ctx, code, transaction) {
  const [rows] = await transaction.sequelize.query(
    `SELECT DISTINCT m.user_id AS "userId" FROM core.user_memberships m
       JOIN core.role_permissions rp ON rp.role_id = m.role_id
       JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND p.code = :code`,
    { replacements: { companyId: ctx.companyId, code }, transaction }
  );
  return rows.map((r) => r.userId);
}

async function alertManagers(ctx, aviso, transaction) {
  const titulo = `Vulnerabilidade ${aviso.severity} em dependência`;
  const corpo = `${aviso.package}: ${aviso.title}. ${FAILED_MESSAGE}`;
  const users = await usersWithPermission(ctx, PERMISSAO_AVISO, transaction);
  for (const userId of users) {
    await Notification.create({ groupId: ctx.groupId, companyId: ctx.companyId, userId, channel: 'IN_APP', title: titulo, body: corpo.slice(0, 1000), createdBy: null, updatedBy: null }, { transaction });
  }
  return users.length;
}

/**
 * Grava um erro de integração (origem CONTRACT, classe SECURITY, SDK_VULNERABILITY, gravidade pela do aviso) por aviso
 * bloqueante da empresa e avisa quem tem integration:manage SÓ quando o aviso é novo (primeira ocorrência do grupo).
 * Devolve { recorded, alerted }.
 */
async function reportFindings(ctx, findings, transaction) {
  let alerted = 0;
  for (const a of findings) {
    const registro = await recordError(ctx, {
      providerCode: a.package, source: 'CONTRACT', sourceRefId: advisoryRefId(a), errorClass: 'SECURITY', errorCode: ERROR_CODE,
      severity: SEVERITY_MAP[a.severity], operation: 'dependency_audit',
      message: `Vulnerabilidade ${a.severity} em ${a.package} (${a.id}): ${a.title}. ${FAILED_MESSAGE}`,
      payload: { advisory: a.id, package: a.package, severity: a.severity, range: a.range, exceptionProblem: a.exceptionProblem || null },
    }, transaction);
    if (registro.attempts === 1) { await alertManagers(ctx, a, transaction); alerted += 1; }
  }
  return { recorded: findings.length, alerted };
}

/** SDK de fornecedor sem versão exata (integration.sdk.pin_exact): erro de contrato de gravidade média, sem aviso por notificação. */
async function reportPinViolations(ctx, violations, transaction) {
  for (const v of violations) {
    await recordError(ctx, {
      providerCode: v.package, source: 'CONTRACT', errorClass: 'VALIDATION', errorCode: 'SDK_NOT_PINNED', operation: 'dependency_audit',
      message: `${v.message} Fixe a versão exata no package.json.`, payload: { package: v.package, version: v.version, field: v.field },
    }, transaction);
  }
  return violations.length;
}

module.exports = { reportFindings, reportPinViolations, PERMISSAO_AVISO };
