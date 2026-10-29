'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Kill switch do Marketing (M9-D239 3.2 item 5: "sobrepõe tudo"). Vale o da campanha do conteúdo (marketing.campaigns.kill_switch_active) e
 * qualquer verificação registrada por quem é dono do kill switch geral (M9-D425): `registerKillSwitchCheck(fn)`, com `fn({ companyId,
 * campaignId, transaction })` devolvendo true quando a publicação deve parar. Sem registro, só vale o da campanha.
 */
const extraChecks = [];

function registerKillSwitchCheck(fn) {
  if (typeof fn !== 'function') return () => {};
  extraChecks.push(fn);
  return () => { const i = extraChecks.indexOf(fn); if (i >= 0) extraChecks.splice(i, 1); };
}

async function isKillSwitchActive({ companyId, campaignId, transaction }) {
  if (campaignId) {
    const [row] = await sequelize.query(
      'SELECT kill_switch_active FROM marketing.campaigns WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL',
      { replacements: { id: campaignId, companyId }, transaction, type: QueryTypes.SELECT }
    );
    if (row && row.kill_switch_active) return true;
  }
  for (const check of [...extraChecks]) {
    if (await check({ companyId, campaignId, transaction })) return true;
  }
  return false;
}

module.exports = { isKillSwitchActive, registerKillSwitchCheck };
