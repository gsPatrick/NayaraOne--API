'use strict';

const AppError = require('../../utils/AppError');
const { PLATFORM_PERMISSION_CODES } = require('./index');

/**
 * Papel e vínculo do OPERADOR DE PLATAFORMA (Marco 9, M9-D200 R4-L4): um papel que carrega permissão de plataforma é preparado pela operação da plataforma
 * (fora da API de empresa). O ADMIN da empresa não o renomeia, esvazia, edita nem apaga, e não revoga o vínculo de quem o tem: senão a empresa trancaria a equipe
 * da plataforma fora do próprio tenant. A trava vale para todos os caminhos da API (roles.service e membership.service).
 */
async function roleCarriesPlatformPermission(roleId, transaction) {
  if (!roleId) return false;
  const { RolePermission, Permission } = require('../../models');
  const achadas = await RolePermission.count({
    where: { roleId },
    include: [{ model: Permission, as: 'permission', required: true, where: { code: PLATFORM_PERMISSION_CODES } }],
    transaction,
  });
  return achadas > 0;
}

/** Recusa (403 PLATFORM_ROLE_PROTECTED) qualquer alteração, pela API de empresa, de papel (ou vínculo a papel) de plataforma. */
async function assertRoleNotPlatform(roleId, transaction) {
  if (await roleCarriesPlatformPermission(roleId, transaction)) {
    throw AppError.forbidden('Papel da equipe da plataforma não pode ser alterado nem removido pela empresa.', 'PLATFORM_ROLE_PROTECTED', { roleId });
  }
}

module.exports = { roleCarriesPlatformPermission, assertRoleNotPlatform };
