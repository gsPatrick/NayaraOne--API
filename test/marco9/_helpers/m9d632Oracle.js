'use strict';

// Oráculo da M9-D632: recalcula cada KPI do ZERO só com as linhas-fonte (SQL direto nas tabelas do CRM e do cadastro de imóveis por superusuário), sem
// passar por read model, fórmula ou snapshot. Mês de São Paulo da data-base: de 01/10 até 28/10/2026 (fim exclusivo 29/10 00:00 de São Paulo).
const FROM = '2026-10-01T03:00:00Z';
const TO = '2026-10-29T03:00:00Z';
const ONE = async (env, sql, t, extra = {}) => (await env.admin.query(sql, { replacements: { c: t.companyId, from: FROM, to: TO, ...extra } }))[0][0];

const visits = (env, t) => ONE(env, `SELECT count(*) FILTER (WHERE status <> 'CANCELED')::int AS scheduled, count(*) FILTER (WHERE status = 'DONE')::int AS done,
  count(*) FILTER (WHERE status <> 'CANCELED' AND agent_user_id IS NULL)::int AS "withoutBroker" FROM crm.visits WHERE company_id = :c AND deleted_at IS NULL AND scheduled_at >= :from AND scheduled_at < :to`, t);

const proposals = (env, t) => ONE(env, `SELECT count(*)::int AS sent, count(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
  count(*) FILTER (WHERE status IN ('SENT', 'UNDER_NEGOTIATION'))::int AS open, COALESCE(sum(value), 0)::text AS "valueSent", count(*) FILTER (WHERE value IS NULL OR value <= 0)::int AS "withoutValue"
  FROM crm.proposals WHERE company_id = :c AND deleted_at IS NULL AND sent_at >= :from AND sent_at < :to`, t);

const ACTIVE = `p.company_id = :c AND p.deleted_at IS NULL AND p.availability_status = 'AVAILABLE' AND COALESCE(p.publication_status, '') <> 'INACTIVE'`;
const offerOf = (types) => `EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.property_id = p.id AND o.deleted_at IS NULL AND o.status = 'ACTIVE' AND o.offer_type IN (${types}))`;

const activeProperties = (env, t) => ONE(env, `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${offerOf("'SALE'")})::int AS sale,
  count(*) FILTER (WHERE ${offerOf("'RENT', 'SEASONAL'")} AND NOT ${offerOf("'SALE'")})::int AS rent FROM real_estate.properties p WHERE ${ACTIVE}`, t);

/** Dias de calendário de São Paulo entre a publicação e a data-base (28/10/2026); faixas pelos limites dados (ex.: [30, 90, 180]). */
async function withoutSale(env, t, limits = [30, 90, 180]) {
  const [rows] = await env.admin.query(`SELECT ('2026-10-28'::date - ((p.published_at AT TIME ZONE 'America/Sao_Paulo')::date)) AS days, (p.published_at IS NULL) AS "noDate"
    FROM real_estate.properties p WHERE ${ACTIVE} AND p.publication_status = 'PUBLISHED' AND ${offerOf("'SALE'")}`, { replacements: { c: t.companyId } });
  const counts = Array(limits.length + 1).fill(0);
  let noDate = 0;
  for (const r of rows) {
    if (r.noDate) { noDate += 1; continue; }
    const i = limits.findIndex((l) => Number(r.days) <= l);
    counts[i === -1 ? limits.length : i] += 1;
  }
  return { counts, noDate };
}

const priceChanges = (env, t) => ONE(env, `SELECT count(*)::int AS changes, count(*) FILTER (WHERE old_price > 0)::int AS "withPrior",
  ROUND(AVG((new_price - old_price) / old_price * 100) FILTER (WHERE old_price > 0), 2)::text AS average
  FROM real_estate.property_price_history WHERE company_id = :c AND changed_at >= :from AND changed_at < :to`, t);

module.exports = { visits, proposals, activeProperties, withoutSale, priceChanges, FROM, TO };
