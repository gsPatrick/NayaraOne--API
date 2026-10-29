'use strict';

// Oráculo da M9-D633: recalcula cada KPI do ZERO só com as linhas-fonte (SQL direto no outbox, nas oportunidades e nos imóveis por superusuário), sem passar
// por read model, fórmula ou snapshot. Mês de São Paulo da data-base: de 01/10 até 28/10/2026 (fim exclusivo 29/10 00:00 de São Paulo).
const { FROM, TO } = require('./m9d632Oracle');

const ROWS = async (env, sql, t) => (await env.admin.query(sql, { replacements: { c: t.companyId, from: FROM, to: TO } }))[0];

async function radar(env, t) {
  const [row] = await ROWS(env, `SELECT count(*)::int AS matches, count(*) FILTER (WHERE e.status IN ('PUBLISHED', 'PROCESSED'))::int AS sent,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM crm.visits v WHERE v.company_id = e.company_id AND v.deleted_at IS NULL AND v.status <> 'CANCELED' AND v.created_at >= e.occurred_at
      AND v.person_id::text = e.payload_json->>'personId' AND v.property_id::text = e.payload_json->>'propertyId')
      OR EXISTS (SELECT 1 FROM crm.opportunities o WHERE o.company_id = e.company_id AND o.deleted_at IS NULL AND o.created_at >= e.occurred_at
      AND o.person_id::text = e.payload_json->>'personId' AND o.property_id::text = e.payload_json->>'propertyId'))::int AS converted,
    count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM crm.property_radars r WHERE r.id::text = e.aggregate_id::text AND r.deleted_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM real_estate.properties p WHERE p.id::text = e.payload_json->>'propertyId' AND p.deleted_at IS NULL AND COALESCE(p.publication_status, '') <> 'INACTIVE'))::int AS invalid
    FROM integration.outbox_events e WHERE e.company_id = :c AND e.event_type = 'radar.matched' AND e.occurred_at >= :from AND e.occurred_at < :to`, t);
  return row;
}

/** { total, byBroker: { id|null: n }, withValue, valueSum } dos imóveis cadastrados no mês (oferta ativa; a de venda tem preferência). */
async function capture(env, t) {
  const list = await ROWS(env, `SELECT p.created_by::text AS broker, (SELECT o.asking_price FROM real_estate.property_offers o WHERE o.property_id = p.id AND o.deleted_at IS NULL AND o.status = 'ACTIVE'
      ORDER BY (o.offer_type = 'SALE') DESC, o.created_at LIMIT 1)::text AS price FROM real_estate.properties p
    WHERE p.company_id = :c AND p.deleted_at IS NULL AND p.created_at >= :from AND p.created_at < :to`, t);
  const byBroker = {};
  let valueSum = 0;
  let withValue = 0;
  for (const r of list) {
    byBroker[r.broker] = (byBroker[r.broker] || 0) + 1;
    if (r.price !== null) { withValue += 1; valueSum += Math.round(Number(r.price) * 100); }
  }
  return { total: list.length, byBroker, withValue, average: withValue ? (Math.round(valueSum / withValue) / 100).toFixed(2) : null };
}

async function conversion(env, t) {
  const list = await ROWS(env, `SELECT owner_user_id::text AS broker, count(*) FILTER (WHERE stage = 'CLOSED_WON')::int AS won, count(*) FILTER (WHERE stage = 'CLOSED_LOST')::int AS lost
    FROM crm.opportunities WHERE company_id = :c AND deleted_at IS NULL AND stage IN ('CLOSED_WON', 'CLOSED_LOST') AND closed_at >= :from AND closed_at < :to GROUP BY 1`, t);
  const won = list.reduce((a, r) => a + r.won, 0);
  const lost = list.reduce((a, r) => a + r.lost, 0);
  return { brokers: Object.fromEntries(list.map((r) => [r.broker, r])), won, lost, rate: ((won * 100) / (won + lost)).toFixed(2) };
}

module.exports = { radar, capture, conversion };
