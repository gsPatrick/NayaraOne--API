'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Porta de entrada de quem executa ações de uma campanha (disparo dos steps aqui; runner de automação em M9-D414). Campanha que
 * não está RUNNING (inexistente, rascunho, agendada ou ENCERRADA) bloqueia com CAMPAIGN_NOT_RUNNING; kill switch da campanha ligado
 * bloqueia com CAMPAIGN_KILL_SWITCH_ACTIVE (a regra do kill switch é da M9-D425). Nunca lança: devolve a decisão.
 */
async function assertCampaignRunning(campaignId, tenant, transaction) {
  if (!UUID_RE.test(String(campaignId))) return { allowed: false, blockCode: 'CAMPAIGN_NOT_RUNNING', status: null };
  const [row] = await sequelize.query(
    'SELECT status, kill_switch_active FROM marketing.campaigns WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL',
    { replacements: { id: campaignId, companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT }
  );
  if (!row || row.status !== 'RUNNING') return { allowed: false, blockCode: 'CAMPAIGN_NOT_RUNNING', status: row ? row.status : null };
  if (row.kill_switch_active) return { allowed: false, blockCode: 'CAMPAIGN_KILL_SWITCH_ACTIVE', status: row.status };
  return { allowed: true, status: row.status };
}

module.exports = { assertCampaignRunning };
