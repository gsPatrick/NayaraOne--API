'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { MODELS, UNATTRIBUTED } = require('./tracking.catalog');
const { modelUnsupported, invalidInput } = require('./tracking.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

function parseFilters(query) {
  const q = query || {};
  const campaignId = q.campaignId || null;
  if (campaignId && !UUID_RE.test(String(campaignId))) throw invalidInput('Dados inválidos: campaignId.', { field: 'campaignId' });
  const model = q.model ? String(q.model).toLowerCase() : null;
  if (model && !MODELS.includes(model)) throw modelUnsupported({ model: String(q.model), allowed: MODELS });
  const range = {};
  for (const f of ['from', 'to']) {
    if (q[f] === undefined || q[f] === '') { range[f] = null; continue; }
    const d = new Date(q[f]);
    if (Number.isNaN(d.getTime())) throw invalidInput(`Dados inválidos: ${f}.`, { field: f });
    range[f] = d;
  }
  return { campaignId, model, from: range.from, to: range.to };
}

const WHERE_RANGE = 'e.valid AND (CAST(:from AS timestamptz) IS NULL OR e.occurred_at >= CAST(:from AS timestamptz)) AND (CAST(:to AS timestamptz) IS NULL OR e.occurred_at <= CAST(:to AS timestamptz))';

/** Funil por campanha e canal (contagens). Cliques anônimos entram só na contagem; ninguém é identificado. */
function funnelSql() {
  return `SELECT e.campaign_id, COALESCE(tl.channel, 'SEM_LINK') AS channel,
            count(*) FILTER (WHERE e.event_type = 'CLICK')::int AS clicks,
            count(*) FILTER (WHERE e.event_type = 'CLICK' AND e.person_id IS NOT NULL)::int AS identified_clicks,
            count(*) FILTER (WHERE e.event_type = 'LEAD_CREATED')::int AS leads,
            count(*) FILTER (WHERE e.event_type = 'VISIT')::int AS visits,
            count(*) FILTER (WHERE e.event_type = 'PROPOSAL')::int AS proposals
          FROM marketing.attribution_events e LEFT JOIN marketing.tracking_links tl ON tl.id = e.tracking_link_id AND tl.company_id = e.company_id
         WHERE e.event_type <> 'SALE' AND ${WHERE_RANGE} AND (CAST(:campaignId AS uuid) IS NULL OR e.campaign_id = CAST(:campaignId AS uuid))
         GROUP BY e.campaign_id, COALESCE(tl.channel, 'SEM_LINK')`;
}

/** Vendas atribuídas pelo toque do modelo: a campanha e o canal são os do toque (First: firstTouchEventId; Last: lastTouchEventId). */
function salesSql(touchKey) {
  return `SELECT t.campaign_id, COALESCE(tl.channel, 'SEM_LINK') AS channel, count(*)::int AS sales,
            COALESCE(sum((e.evidence_json->>'contractValue')::numeric), 0) AS value
          FROM marketing.attribution_events e
          JOIN marketing.attribution_events t ON t.id = (e.evidence_json->>'${touchKey}')::uuid AND t.company_id = e.company_id
          LEFT JOIN marketing.tracking_links tl ON tl.id = t.tracking_link_id AND tl.company_id = t.company_id
         WHERE e.event_type = 'SALE' AND ${WHERE_RANGE} AND (CAST(:campaignId AS uuid) IS NULL OR t.campaign_id = CAST(:campaignId AS uuid))
         GROUP BY t.campaign_id, COALESCE(tl.channel, 'SEM_LINK')`;
}

async function unattributed(filters, transaction) {
  if (filters.campaignId) return null;
  const [row] = await sequelize.query(
    `SELECT count(*)::int AS sales, COALESCE(sum((e.evidence_json->>'contractValue')::numeric), 0) AS value FROM marketing.attribution_events e
      WHERE e.event_type = 'SALE' AND ${WHERE_RANGE} AND e.evidence_json->>'attribution' = :tag`,
    { replacements: { from: filters.from, to: filters.to, tag: UNATTRIBUTED }, transaction, type: QueryTypes.SELECT }
  );
  return { sales: row.sales, value: money(row.value) };
}

/**
 * GET /marketing/attribution?campaignId=&from=&to=&model=first|last — contagens e valores por campanha e canal, agregados (sem
 * pessoas). "Valor" = soma de evidence_json.contractValue dos eventos SALE atribuídos à campanha pelo modelo; sem `model`, os dois.
 */
async function attributionReport(tenant, query, transaction) {
  const filters = parseFilters(query);
  const base = { from: filters.from, to: filters.to, campaignId: filters.campaignId };
  const run = (sql) => sequelize.query(sql, { replacements: base, transaction, type: QueryTypes.SELECT });
  const models = filters.model ? [filters.model] : MODELS;
  const funnel = await run(funnelSql());
  const salesByModel = {};
  for (const m of models) salesByModel[m] = await run(salesSql(m === 'first' ? 'firstTouchEventId' : 'lastTouchEventId'));

  const key = (cid, ch) => `${cid || 'SEM_CAMPANHA'}|${ch}`;
  const rows = new Map();
  const row = (cid, ch) => {
    const k = key(cid, ch);
    if (!rows.has(k)) rows.set(k, { campaignId: cid || null, channel: ch, clicks: 0, identifiedClicks: 0, leads: 0, visits: 0, proposals: 0, models: {} });
    return rows.get(k);
  };
  for (const f of funnel) Object.assign(row(f.campaign_id, f.channel), { clicks: f.clicks, identifiedClicks: f.identified_clicks, leads: f.leads, visits: f.visits, proposals: f.proposals });
  for (const m of models) for (const s of salesByModel[m]) row(s.campaign_id, s.channel).models[m] = { sales: s.sales, value: money(s.value) };
  for (const r of rows.values()) for (const m of models) r.models[m] = r.models[m] || { sales: 0, value: 0 };

  const byCampaign = new Map();
  for (const r of rows.values()) {
    const c = byCampaign.get(r.campaignId) || { campaignId: r.campaignId, clicks: 0, identifiedClicks: 0, leads: 0, visits: 0, proposals: 0, models: Object.fromEntries(models.map((m) => [m, { sales: 0, value: 0 }])), channels: [] };
    for (const f of ['clicks', 'identifiedClicks', 'leads', 'visits', 'proposals']) c[f] += r[f];
    for (const m of models) { c.models[m].sales += r.models[m].sales; c.models[m].value = money(c.models[m].value + r.models[m].value); }
    c.channels.push({ channel: r.channel, clicks: r.clicks, identifiedClicks: r.identifiedClicks, leads: r.leads, visits: r.visits, proposals: r.proposals, models: r.models });
    byCampaign.set(r.campaignId, c);
  }
  return {
    model: filters.model, models, from: filters.from, to: filters.to, campaignId: filters.campaignId,
    campaigns: [...byCampaign.values()].sort((a, b) => String(a.campaignId).localeCompare(String(b.campaignId))),
    unattributed: await unattributed(filters, transaction),
  };
}

module.exports = { attributionReport, parseFilters };
