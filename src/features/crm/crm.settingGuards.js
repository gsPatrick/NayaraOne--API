'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registerSettingGuard } = require('../settings/settingGuards');
const { KEYS, CRM_SETTING_DEFAULTS, parseReasonList } = require('./crm.settings');
const { isActiveMember } = require('./crmUsers');

/**
 * Travas de gravação dos parâmetros do CRM (rodam depois do formato e antes de gravar, em qualquer caminho de escrita):
 *  - responsável padrão do lead automático: usuário ativo desta empresa;
 *  - permissão da gerência: código existente no catálogo de permissões;
 *  - motivos de perda e de desistência: o mesmo código não pode estar nas duas listas (o LOST aceita as duas e a categoria do
 *    motivo decide se a perda foi desistência).
 */

registerSettingGuard(KEYS.defaultLeadOwner, async (value, tenant, actorUserId, transaction) => {
  if (!(await isActiveMember(value, tenant.companyId, transaction))) {
    throw AppError.badRequest('O responsável padrão precisa ser um usuário ativo desta empresa.', 'SETTING_INVALID_VALUE', { key: KEYS.defaultLeadOwner, value });
  }
});

registerSettingGuard(KEYS.managerPermission, async (value, tenant, actorUserId, transaction) => {
  const rows = await sequelize.query('SELECT 1 FROM core.permissions WHERE code = :code LIMIT 1', {
    replacements: { code: value }, type: QueryTypes.SELECT, transaction,
  });
  if (rows.length === 0) {
    throw AppError.badRequest(`A permissão "${value}" não existe no catálogo de permissões.`, 'SETTING_INVALID_VALUE', { key: KEYS.managerPermission, value });
  }
});

function guardDisjointReasons(key, otherKey) {
  registerSettingGuard(key, async (value, tenant, actorUserId, transaction) => {
    const { getSetting } = require('../settings/settings.service');
    const other = parseReasonList(await getSetting(otherKey, tenant, transaction, CRM_SETTING_DEFAULTS[otherKey])) || [];
    const otherCodes = new Set(other.map((r) => r.code));
    const repeated = (parseReasonList(value) || []).map((r) => r.code).filter((code) => otherCodes.has(code));
    if (repeated.length > 0) {
      throw AppError.badRequest(
        `Motivo repetido entre perda e desistência: ${repeated.join(', ')}. Cada código pertence a uma lista só.`,
        'SETTING_INVALID_VALUE',
        { key, value, repeated }
      );
    }
  });
}

guardDisjointReasons(KEYS.lostReasons, KEYS.withdrawalReasons);
guardDisjointReasons(KEYS.withdrawalReasons, KEYS.lostReasons);

module.exports = {};
