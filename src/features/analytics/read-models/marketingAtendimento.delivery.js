'use strict';

/**
 * M9-D627 — rm_mkt_delivery: por dia (SP) e canal, mensagens enviadas (OUTBOUND de automação ou campanha, isto é, com action_key), entregues,
 * com falha e opt-outs. Entregue = DELIVERED ou READ; falha = os estados que o cap não conta (FAILED, UNDELIVERED, BOUNCED). Opt-out vem de
 * marketing.suppression_list com motivo OPT_OUT. O status de entrega que chega depois da criação da mensagem entra pelo evento
 * crm.message.status_changed (publicado por messages.service) e, no fim, pela agenda. M9-D671 acrescenta as devolvidas (BOUNCED), a mensagem mais antiga
 * ainda sem status final de entrega e o enviado/entregue por campanha (a campanha da mensagem vem de campaign_step_deliveries pela action_key).
 */
const { DELIVERED_STATUSES, FAILED_STATUSES, FINAL_DELIVERY_STATUSES } = require('./marketingAtendimento.statuses');
const { DAY_RE, sqlDay, TZ, dayKey, rows } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['crm.interaction.recorded', 'crm.message.status_changed', 'customer.opted_out']);

function aggregateKey(event) {
  const p = event.payloadJson || event.payload || {};
  const channel = String(p.channel || '').toUpperCase();
  if (!channel) return null;
  if (event.eventType === 'crm.interaction.recorded') return String(p.direction || '').toUpperCase() === 'OUTBOUND' ? { day: dayKey(event.occurredAt), channel } : null;
  if (event.eventType === 'crm.message.status_changed') return DAY_RE.test(String(p.day || '')) ? { day: p.day, channel } : null;
  return { day: dayKey(p.occurredAt || event.occurredAt), channel }; // customer.opted_out
}

async function recompute({ companyId, key, transaction }) {
  const [m] = await rows(
    `SELECT count(*) FILTER (WHERE action_key IS NOT NULL)::int AS sent,
            count(*) FILTER (WHERE action_key IS NOT NULL AND status IN (:delivered))::int AS delivered,
            count(*) FILTER (WHERE action_key IS NOT NULL AND status IN (:failed))::int AS failed,
            count(*) FILTER (WHERE action_key IS NOT NULL AND status = 'BOUNCED')::int AS bounced,
            min(created_at) FILTER (WHERE action_key IS NOT NULL AND status NOT IN (:final)) AS awaiting_since
       FROM crm.messages
      WHERE company_id = :companyId AND direction = 'OUTBOUND' AND channel = :channel AND ${sqlDay('created_at')} = :day`,
    { ...TZ, companyId, channel: key.channel, day: key.day, delivered: DELIVERED_STATUSES, failed: FAILED_STATUSES, final: FINAL_DELIVERY_STATUSES }, transaction
  );
  const campaigns = await rows(
    `SELECT COALESCE(d.campaign_id::text, 'SEM_CAMPANHA') AS campaign, count(*)::int AS sent, count(*) FILTER (WHERE m.status IN (:delivered))::int AS delivered
       FROM crm.messages m LEFT JOIN marketing.campaign_step_deliveries d ON d.company_id = m.company_id AND d.action_key = m.action_key
      WHERE m.company_id = :companyId AND m.direction = 'OUTBOUND' AND m.action_key IS NOT NULL AND m.channel = :channel AND ${sqlDay('m.created_at')} = :day GROUP BY 1`,
    { ...TZ, companyId, channel: key.channel, day: key.day, delivered: DELIVERED_STATUSES }, transaction
  );
  const [o] = await rows(
    `SELECT count(*)::int AS n FROM marketing.suppression_list
      WHERE company_id = :companyId AND reason = 'OPT_OUT' AND channel = :channel AND deleted_at IS NULL AND ${sqlDay('created_at')} = :day`,
    { ...TZ, companyId, channel: key.channel, day: key.day }, transaction
  );
  const byCampaign = Object.fromEntries(campaigns.map((c) => [c.campaign, { sent: c.sent, delivered: c.delivered }]));
  return { fields: { sent: m.sent, delivered: m.delivered, failed: m.failed, opt_out: o.n, bounced: m.bounced, awaiting_since: m.awaiting_since, by_campaign: byCampaign } };
}

const KEYS_SQL = (filter) => `
  SELECT ${sqlDay('created_at')} AS day, channel FROM crm.messages WHERE company_id = :companyId AND direction = 'OUTBOUND' ${filter}
  UNION
  SELECT ${sqlDay('created_at')} AS day, channel FROM marketing.suppression_list WHERE company_id = :companyId AND reason = 'OPT_OUT' AND deleted_at IS NULL AND created_at IS NOT NULL ${filter}
  ORDER BY 1, 2`;

async function scheduledKeys({ companyId, now, windowDays, limit, transaction }) {
  const since = new Date(now.getTime() - windowDays * 86400000);
  return rows(`${KEYS_SQL('AND created_at >= :since')} LIMIT :limit`, { ...TZ, companyId, since, limit: limit || 5000 }, transaction);
}

const rebuildKeys = ({ companyId, transaction }) => rows(KEYS_SQL(''), { ...TZ, companyId }, transaction);

module.exports = { name: 'rm_mkt_delivery', keyColumns: ['day', 'channel'], eventTypes: EVENTS, aggregateKey, recompute, scheduledKeys, rebuildKeys };
