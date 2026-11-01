'use strict';

const AppError = require('../../utils/AppError');
const { restrictedPermissionOf } = require('./settingRestricted');

/**
 * Camada de escrita (M9-D870, reabertura R4-M1): cada chave do SETTINGS_SCHEMA declara a permissão exigida para gravá-la (`restrictedPermissionOf`: marketing:template:manage,
 * marketing:automation:manage, ai:admin, integration:manage, governance:*). Quem chega com a sessão informa as permissões que tem em `options.permissions` (PUT /settings e o
 * registro de flags); a camada recusa com 403 `SETTING_PERMISSION_REQUIRED` antes de gravar. Código interno que não passa `permissions` (seeds, jobs, migrações) segue como antes.
 */
const CODE = 'SETTING_PERMISSION_REQUIRED';

function assertWritePermission(key, permissions) {
  if (!Array.isArray(permissions)) return;
  const required = restrictedPermissionOf(key);
  if (required && !permissions.includes(required)) {
    throw AppError.forbidden('Você não tem permissão para alterar este parâmetro. Peça o acesso a quem administra o seu perfil.', CODE, { key, required });
  }
}

module.exports = { assertWritePermission, CODE };
