'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { runLifecycleTick } = require('../../features/marketing/campaigns/lifecycle.service');

/**
 * campaignLifecycleJob (M9-D412) — a cada minuto, para cada empresa: campanha SCHEDULED com starts_at vencido vira RUNNING (evento
 * marketing.campaign.started); RUNNING com ends_at vencido vira ENDED (marketing.campaign.ended), com resultado calculado e o que
 * estava pendente cancelado; e os steps devidos são disparados. Os instantes são comparados em UTC (timestamptz), então o fuso do
 * servidor não interfere; o horário de Brasília (America/Sao_Paulo) é aplicado na entrada das datas sem fuso.
 *
 * Sem `req` HTTP: percorre grupos e empresas abrindo a mesma transação com SET LOCAL app.group_id/app.company_id do
 * tenant.middleware.js (fail-closed, igual aos jobs do Radar e dos alertas jurídicos).
 */
const INTERVAL_MS = 60 * 1000;

async function runCompany(group, company, now) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
      replacements: { groupId: group.id, companyId: company.id }, transaction,
    });
    return runLifecycleTick({ groupId: group.id, companyId: company.id }, transaction, now);
  });
}

async function runCampaignLifecycleJob(now = new Date()) {
  const summary = { companies: 0, started: 0, ended: 0, sent: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      summary.companies += 1;
      try {
        const result = await runCompany(group, company, now);
        summary.started += result.started.length;
        summary.ended += result.ended.length;
        summary.sent += result.dispatch.sent;
      } catch (err) {
        summary.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'campaignLifecycleJob.company.failed');
      }
    }
  }
  if (summary.started || summary.ended || summary.sent || summary.errors) logger.info(summary, 'campaignLifecycleJob.run');
  return summary;
}

function startCampaignLifecycleJob({ intervalMs = INTERVAL_MS } = {}) {
  const tick = () => runCampaignLifecycleJob().catch((err) => logger.error({ err: err.message }, 'campaignLifecycleJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runCampaignLifecycleJob, startCampaignLifecycleJob };
