'use strict';

/**
 * M9-D670 / M9-D671 — leitura dos read models de Marketing para o cálculo dos KPIs. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de
 * read models gravou (M9-D607). Os KPIs de fluxo leem o mês de São Paulo da data-base; campanhas e frequência leem o estado de hoje. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./mkt.definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');
const dates = require('../../period.dates');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));
const NO_CAMPAIGN = '00000000-0000-0000-0000-000000000000';
const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

/** Campanhas (estado de hoje) e o resultado do mês de cada uma, unidos: toda campanha aparece, com zeros quando não tem linha no mês. */
async function loadCampaignRows(companyId, month, transaction) {
  const base = { companyId, month };
  const campaigns = await select(
    `SELECT campaign_id::text AS campaign, state, channels, to_char(started_on, 'YYYY-MM-DD') AS "startedOn", to_char(ended_on, 'YYYY-MM-DD') AS "endedOn", has_cost_link AS "hasCostLink"
       FROM analytics.${T['mkt.campaigns']} WHERE company_id = :companyId ORDER BY campaign_id`, base, transaction
  );
  const monthly = await select(
    `SELECT campaign_id::text AS campaign, cost_settled::text AS settled, cost_planned::text AS planned, leads_total AS leads, leads_last AS "leadsLast", leads_first AS "leadsFirst",
            sales_last AS sales, outside_window AS "outsideWindow" FROM analytics.${T['mkt.leads']} WHERE company_id = :companyId AND month = :month ORDER BY campaign_id`, base, transaction
  );
  const byId = new Map(monthly.map((m) => [m.campaign, m]));
  const known = new Set(campaigns.map((c) => c.campaign));
  const zero = { settled: '0.00', planned: '0.00', leads: 0, leadsLast: 0, leadsFirst: 0, sales: 0, outsideWindow: 0 };
  const joined = campaigns.map((c) => ({ ...zero, ...(byId.get(c.campaign) || {}), ...c }));
  const orphans = monthly.filter((m) => m.campaign !== NO_CAMPAIGN && !known.has(m.campaign)).map((m) => ({ ...m, state: null, channels: [], startedOn: null, endedOn: null, hasCostLink: true }));
  return { campaigns: [...joined, ...orphans], noCampaign: { ...zero, ...(byId.get(NO_CAMPAIGN) || {}), campaign: NO_CAMPAIGN, channels: [] } };
}

async function loadRows(scope, asOfDate, settings, transaction) {
  const { companyId } = scope;
  const month = asOfDate.slice(0, 7);
  const first = `${month}-01`;
  const window = { companyId, from: first, to: dates.addMonthsFirstDay(first, 1), day: asOfDate };
  const { campaigns, noCampaign } = await loadCampaignRows(companyId, month, transaction);
  const delivery = await select(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, channel, sent, delivered, failed, bounced, awaiting_since AS "awaitingSince", by_campaign AS "byCampaign"
       FROM analytics.${T['mkt.deliverability']} WHERE company_id = :companyId AND day >= :from AND day < :to ORDER BY day, channel`, window, transaction
  );
  const optOut = await select(`SELECT channel, reached, opt_outs AS "optOuts", undated FROM analytics.${T['mkt.opt_out']} WHERE company_id = :companyId AND month = :month ORDER BY channel`, { companyId, month }, transaction);
  const [frequency] = await select(
    `SELECT window_days AS "windowDays", window_messages AS "windowMessages", window_people AS "windowPeople", unidentified, contacts_over_cap AS "overCap", by_channel AS "byChannel"
       FROM analytics.${T['mkt.frequency']} WHERE company_id = :companyId AND day = :day`, window, transaction
  );
  const automation = await select(
    `SELECT executed, failed, blocked_without_reason AS "blockedWithoutReason", blocked_by_reason AS "blockedByReason", failed_by_code AS "failedByCode", by_automation AS "byAutomation"
       FROM analytics.${T['mkt.automations_blocked_failed']} WHERE company_id = :companyId AND day >= :from AND day < :to ORDER BY day`, window, transaction
  );
  const at = (...codes) => latestSnapshotAt(companyId, [...new Set(codes.map((c) => T[c]))], transaction);
  return {
    month, campaigns, noCampaign, delivery: delivery.map((r) => ({ ...r, awaitingSince: iso(r.awaitingSince) })), optOut, frequency: frequency || null, automation,
    snapshotAt: {
      'mkt.campaigns': await at('mkt.campaigns'), 'mkt.cost': await at('mkt.cost'), 'mkt.leads': await at('mkt.leads'), 'mkt.attribution': await at('mkt.attribution'),
      'mkt.deliverability': await at('mkt.deliverability'), 'mkt.opt_out': await at('mkt.opt_out'), 'mkt.frequency': await at('mkt.frequency'), 'mkt.automations_blocked_failed': await at('mkt.automations_blocked_failed'),
    },
  };
}

module.exports = { loadRows, NO_CAMPAIGN, MKT_READ_MODELS: [...new Set(Object.values(T))] };
