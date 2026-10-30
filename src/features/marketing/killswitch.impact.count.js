'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { SCOPES } = require('./killswitch.constants');

const one = async (sql, transaction, replacements) => (await sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements }))[0].n;

/**
 * O que o kill switch para (ou devolve) em cada escopo, calculado pelo servidor (M9-D852): campanhas em andamento, passos de campanha agendados, publicações pendentes e
 * automações ativas. Só leitura. O canal filtra pelo canal da campanha, do passo e da publicação; a automação por ação com esse canal na versão publicada.
 */
async function impactCounts(tenant, { scope, targetId }, transaction) {
  const c = { companyId: tenant.companyId, target: targetId };
  const campaignsWhere = { [SCOPES.GLOBAL]: '', [SCOPES.CHANNEL]: 'AND :target = ANY(c.channels)', [SCOPES.CAMPAIGN]: 'AND c.id = :target', [SCOPES.AUTOMATION]: 'AND false' }[scope];
  const campaigns = await one(`SELECT count(*)::int AS n FROM marketing.campaigns c WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.status = 'RUNNING' ${campaignsWhere}`, transaction, c);
  const stepsWhere = { [SCOPES.GLOBAL]: '', [SCOPES.CHANNEL]: 'AND s.channel = :target', [SCOPES.CAMPAIGN]: 'AND s.campaign_id = :target', [SCOPES.AUTOMATION]: 'AND false' }[scope];
  const steps = await one(`SELECT count(*)::int AS n FROM marketing.campaign_steps s WHERE s.company_id = :companyId AND s.deleted_at IS NULL AND s.status = 'SCHEDULED' ${stepsWhere}`, transaction, c);
  const jobsWhere = { [SCOPES.GLOBAL]: '', [SCOPES.CHANNEL]: 'AND j.channel = :target', [SCOPES.CAMPAIGN]: 'AND i.campaign_id = :target', [SCOPES.AUTOMATION]: 'AND false' }[scope];
  const jobs = await one(
    `SELECT count(*)::int AS n FROM marketing.publication_jobs j
       JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
       JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
      WHERE j.company_id = :companyId AND j.deleted_at IS NULL AND j.status = 'PENDING' ${jobsWhere}`, transaction, c
  );
  const flowsWhere = {
    [SCOPES.GLOBAL]: '',
    [SCOPES.CHANNEL]: "AND jsonb_path_exists(av.actions, '$[*] ? (@.channel == $ch)', jsonb_build_object('ch', CAST(:target AS text)))",
    [SCOPES.CAMPAIGN]: 'AND false',
    [SCOPES.AUTOMATION]: 'AND f.id = :target',
  }[scope];
  const automations = await one(
    `SELECT count(DISTINCT f.id)::int AS n FROM marketing.automation_flows f
       JOIN marketing.automation_versions av ON av.id = f.published_version_id AND av.company_id = f.company_id
      WHERE f.company_id = :companyId AND f.deleted_at IS NULL AND f.status = 'ACTIVE' ${flowsWhere}`, transaction, c
  );
  return { campaignsRunning: campaigns, stepsScheduled: steps, publicationsPending: jobs, automationsActive: automations };
}

module.exports = { impactCounts };
