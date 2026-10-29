'use strict';

/**
 * M9-D627 — rm_mkt_campaigns: custo, leads e leads atribuídos por campanha. O custo é o `cost_actual` da campanha, que o Financeiro
 * calcula (M9-D432): nunca digitado. O lead atribuído é o LEAD_CREATED válido da atribuição (M9-D431); a regra de atribuição é da campanha
 * (M9-D670) e o read model guarda só o resultado. M9-D670 acrescenta os campos da campanha (canais, estado, início, fim e vínculo de custo); custo,
 * leads e atribuição por mês ficam em rm_mkt_campaign_month (marketingKpi.campaignMonth.js).
 */
const { UUID_RE, TZ, rows } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['marketing.campaign.started', 'marketing.campaign.ended', 'attribution.recorded']);

function aggregateKey(event) {
  const p = event.payloadJson || event.payload || {};
  return UUID_RE.test(String(p.campaignId || '')) ? { campaign_id: String(p.campaignId).toLowerCase() } : null;
}

async function recompute({ companyId, key, transaction }) {
  const [campaign] = await rows(
    `SELECT c.cost_actual, array_to_string(c.channels, ',') AS channels, c.status AS state,
            to_char((c.starts_at AT TIME ZONE :tz), 'YYYY-MM-DD') AS started_on,
            CASE WHEN c.status = 'ENDED' THEN to_char((c.ends_at AT TIME ZONE :tz), 'YYYY-MM-DD') END AS ended_on,
            (EXISTS (SELECT 1 FROM finance.cost_centers cc WHERE cc.company_id = c.company_id AND cc.code = c.code AND cc.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM finance.financial_entries e WHERE e.company_id = c.company_id AND e.origin_ref = 'campaign:' || c.id::text)) AS has_cost_link
       FROM marketing.campaigns c WHERE c.company_id = :companyId AND c.id = :id AND c.deleted_at IS NULL`,
    { ...TZ, companyId, id: key.campaign_id }, transaction
  );
  const [leads] = await rows('SELECT count(*)::int AS n FROM crm.opportunities WHERE company_id = :companyId AND campaign_id = :id AND deleted_at IS NULL', { companyId, id: key.campaign_id }, transaction);
  const [attributed] = await rows(
    `SELECT count(DISTINCT opportunity_id)::int AS n FROM marketing.attribution_events
      WHERE company_id = :companyId AND campaign_id = :id AND event_type = 'LEAD_CREATED' AND valid = true AND opportunity_id IS NOT NULL`,
    { companyId, id: key.campaign_id }, transaction
  );
  const channels = campaign && campaign.channels ? `{${campaign.channels}}` : '{}'; // literal de text[]: os canais são códigos em maiúsculas
  return {
    fields: {
      cost_total: campaign ? campaign.cost_actual : '0.00', leads_total: leads.n, attributed_leads: attributed.n,
      channels, state: campaign ? campaign.state : null, started_on: campaign ? campaign.started_on : null, ended_on: campaign ? campaign.ended_on : null, has_cost_link: campaign ? campaign.has_cost_link : false,
    },
  };
}

/** Campanhas em andamento (o custo muda pelo job do Financeiro) e as alteradas dentro da janela. */
async function scheduledKeys({ companyId, now, windowDays, limit, transaction }) {
  const since = new Date(now.getTime() - windowDays * 86400000);
  return rows(
    `SELECT id::text AS campaign_id FROM marketing.campaigns
      WHERE company_id = :companyId AND deleted_at IS NULL AND (status = 'RUNNING' OR updated_at >= :since) ORDER BY id LIMIT :limit`,
    { companyId, since, limit: limit || 5000 }, transaction
  );
}

const rebuildKeys = ({ companyId, transaction }) => rows('SELECT id::text AS campaign_id FROM marketing.campaigns WHERE company_id = :companyId AND deleted_at IS NULL ORDER BY id', { companyId }, transaction);

module.exports = { name: 'rm_mkt_campaigns', keyColumns: ['campaign_id'], eventTypes: EVENTS, aggregateKey, recompute, scheduledKeys, rebuildKeys };
