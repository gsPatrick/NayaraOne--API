'use strict';

/**
 * M9-D670 / M9-D671 — entrada de cada fórmula dos KPIs de Marketing a partir das linhas dos read models (mkt.rows) e os parâmetros que a fórmula recebe.
 * Mapeamento puro (sem banco; só o relógio do BI para o limite de horas da entrega): os números chegam como texto inteiro ou decimal e a fórmula faz a conta em
 * decimal exato. A entrada só muda quando a regra muda (o limite de horas vira `staleSince`, não o instante atual), para o snapshot não ganhar revisão à toa.
 */
const clock = require('../../clock');
const { NO_CAMPAIGN } = require('./mkt.rows');

const channelsOf = (r) => r.channels || [];
const campaignRow = (r) => ({ campaign: r.campaign, state: r.state, channels: channelsOf(r), startedOn: r.startedOn, endedOn: r.endedOn, hasCostLink: r.hasCostLink === true, settled: r.settled, planned: r.planned });

/** A mensagem sem status de entrega mais antiga, se já passou do limite de horas; senão nulo. */
function staleSince(rows, maxHours) {
  const oldest = rows.map((r) => r.awaitingSince).filter(Boolean).sort()[0];
  return oldest && clock.now().getTime() - Date.parse(oldest) > maxHours * 3600000 ? oldest : null;
}

const INPUTS = Object.freeze({
  'mkt.campaigns': (r) => ({ month: r.month, rows: r.campaigns.map((c) => ({ campaign: c.campaign, state: c.state, channels: c.state === null ? null : channelsOf(c), endedOn: c.endedOn })) }),
  'mkt.cost': (r) => ({ month: r.month, rows: r.campaigns.map(campaignRow) }),
  'mkt.leads': (r) => ({ rows: [...r.campaigns.map((c) => ({ campaign: c.campaign, channels: channelsOf(c), leads: c.leads })), { campaign: NO_CAMPAIGN, channels: [], leads: r.noCampaign.leads }] }),
  'mkt.attribution': (r) => ({
    rows: r.campaigns.map((c) => ({ campaign: c.campaign, channels: channelsOf(c), hasCostLink: c.hasCostLink === true, cost: c.settled, leads: c.leadsLast, leadsFirst: c.leadsFirst, sales: c.sales })),
    outsideWindow: r.noCampaign.outsideWindow,
  }),
  'mkt.deliverability': (r, ctx) => ({
    staleSince: staleSince(r.delivery, ctx.settings.maxDeliveryHours),
    rows: r.delivery.map((d) => ({ day: d.day, channel: d.channel, sent: d.sent, delivered: d.delivered, failed: d.failed, bounced: d.bounced, byCampaign: d.byCampaign || {} })),
  }),
  'mkt.opt_out': (r) => ({ rows: r.optOut }),
  'mkt.frequency': (r) => ({ row: r.frequency }),
  'mkt.automations_blocked_failed': (r) => ({ rows: r.automation }),
});

const PARAMS = Object.freeze({
  'mkt.leads': (p) => ({ maxNoCampaignPct: p.maxNoCampaignPct }),
  'mkt.attribution': (p) => ({ maxOutsideWindowPct: p.maxOutsideWindowPct }),
  'mkt.deliverability': (p) => ({ maxDeliveryHours: p.maxDeliveryHours }),
  'mkt.frequency': (p) => ({ windowDays: p.frequencyWindowDays }),
});

module.exports = { INPUTS, PARAMS };
