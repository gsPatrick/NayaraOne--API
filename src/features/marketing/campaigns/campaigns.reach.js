'use strict';

const { run } = require('./campaigns.repository');
const suppression = require('../suppression');

/**
 * M9-D419 regra 3 — alcance, cliques e conversões da campanha SÓ em contagens agregadas: o público alcançável nunca inclui suprimidos
 * nem quem pediu para sair, e o alcance distinto conta pessoas pelo person_hash (sha256 do id com o segredo do cofre da empresa),
 * calculado no banco; nenhum id nem hash sai. Cliques = CLICK válidos (inclui o clique anônimo); conversões = SALE válidos.
 */
async function campaignReach(campaign, tenant, transaction, now = new Date()) {
  const base = await suppression.reachable.countReachable({ campaignId: campaign.id, channels: campaign.channels }, tenant, transaction, now);
  // Sem o cofre não há person_hash: o alcance distinto fica null (o resto do resumo não depende dele) em vez de derrubar a consulta.
  const salt = await suppression.personHashSalt(tenant).catch(() => null);
  const [sent] = await run(
    `SELECT count(*)::int AS delivered,
            CASE WHEN CAST(:salt AS text) IS NULL THEN NULL
                 ELSE count(DISTINCT encode(sha256(convert_to(person_id::text || ':' || CAST(:salt AS text), 'UTF8')), 'hex'))::int END AS unique_reach
       FROM marketing.campaign_step_deliveries WHERE campaign_id = :campaignId AND company_id = :companyId AND status = 'SENT'`,
    { campaignId: campaign.id, companyId: tenant.companyId, salt }, transaction
  );
  const [events] = await run(
    `SELECT count(*) FILTER (WHERE event_type = 'CLICK')::int AS clicks, count(*) FILTER (WHERE event_type = 'SALE')::int AS conversions
       FROM marketing.attribution_events WHERE campaign_id = :campaignId AND company_id = :companyId AND valid = true AND deleted_at IS NULL`,
    { campaignId: campaign.id, companyId: tenant.companyId }, transaction
  );
  return { ...base, delivered: sent.delivered, uniqueReach: sent.unique_reach, clicks: events.clicks, conversions: events.conversions };
}

module.exports = { campaignReach };
