'use strict';

// Oráculo da M9-D670: refaz cada número só com as linhas-fonte (consultas diretas às tabelas de origem, sem passar por read model nem fórmula), em centavos
// inteiros e em dias de calendário de São Paulo.
const { dayOf } = require('./m9d660Oracle');

const NIL = '00000000-0000-0000-0000-000000000000';
const rows = async (env, sql, c) => (await env.admin.query(sql, { replacements: { c: c.companyId } }))[0];
const monthOf = (instant) => dayOf(instant).slice(0, 7);
const cents = (amount) => Math.round(Number(amount) * 100);
const money = (n) => (n / 100).toFixed(2);

/** Campanhas ativas (em andamento) e encerradas no mês, por chave de canal (canais unidos por +). */
async function campaignsFromSource(env, t, month) {
  const all = await rows(env, 'SELECT id, status, channels, ends_at FROM marketing.campaigns WHERE company_id = :c AND deleted_at IS NULL', t);
  const key = (ch) => (ch.length ? [...ch].sort().join('+') : 'SEM_CANAL');
  const out = { active: 0, ended: 0, byChannel: {}, noChannel: 0 };
  for (const c of all) {
    const active = c.status === 'RUNNING';
    const ended = c.status === 'ENDED' && monthOf(c.ends_at) === month;
    if (!active && !ended) continue;
    const slot = out.byChannel[key(c.channels)] || (out.byChannel[key(c.channels)] = { active: 0, ended: 0 });
    if (active) { out.active += 1; slot.active += 1; }
    if (ended) { out.ended += 1; slot.ended += 1; }
    if (!c.channels.length) out.noChannel += 1;
  }
  return out;
}

/** Despesas liquidadas e pendentes ligadas a campanhas, no mês (liquidação / vencimento em SP), por campanha. */
async function costFromSource(env, t, month) {
  const campaigns = await rows(env, 'SELECT id, code FROM marketing.campaigns WHERE company_id = :c AND deleted_at IS NULL', t);
  const centers = await rows(env, 'SELECT id, code FROM finance.cost_centers WHERE company_id = :c AND deleted_at IS NULL', t);
  const entries = await rows(env, "SELECT * FROM finance.financial_entries WHERE company_id = :c AND entry_type = 'DEBIT' AND nature = 'PAYABLE' AND is_third_party_funds = false", t);
  const out = { settled: 0, planned: 0, byCampaign: {} };
  for (const e of entries) {
    const byRef = e.origin_ref && e.origin_ref.startsWith('campaign:') ? campaigns.find((c) => c.id === e.origin_ref.slice(9)) : null;
    const center = centers.find((c) => c.id === e.cost_center_id);
    const campaign = byRef || (!e.origin_ref && center ? campaigns.find((c) => c.code === center.code) : null);
    if (!campaign) continue;
    const slot = out.byCampaign[campaign.id] || (out.byCampaign[campaign.id] = { settled: 0, planned: 0 });
    if (e.status === 'SETTLED' && e.settled_at && monthOf(e.settled_at) === month) { out.settled += cents(e.amount); slot.settled += cents(e.amount); }
    if (e.status === 'PENDING' && e.due_at && monthOf(e.due_at) === month) { out.planned += cents(e.amount); slot.planned += cents(e.amount); }
  }
  return out;
}

/** Leads de marketing do mês por campanha, atribuídos (LAST), de primeiro toque (FIRST), vendas e vendas fora da janela. */
async function leadsFromSource(env, t, month) {
  const opps = await rows(env, 'SELECT * FROM crm.opportunities WHERE company_id = :c AND deleted_at IS NULL', t);
  const events = await rows(env, 'SELECT * FROM marketing.attribution_events WHERE company_id = :c AND deleted_at IS NULL', t);
  const out = { total: 0, none: 0, byCampaign: {}, outside: 0 };
  const slot = (id) => out.byCampaign[id] || (out.byCampaign[id] = { leads: 0, last: 0, first: 0, sales: 0 });
  for (const o of opps) {
    if (o.lead_source && monthOf(o.created_at) === month) {
      out.total += 1;
      if (!o.campaign_id) out.none += 1;
      else {
        slot(o.campaign_id).leads += 1;
        if (o.attribution_valid !== false && events.some((e) => e.opportunity_id === o.id && e.event_type === 'LEAD_CREATED' && e.valid && e.campaign_id === o.campaign_id)) slot(o.campaign_id).last += 1;
      }
      const first = events.filter((e) => e.person_id === o.person_id && e.valid && e.touch_roles.includes('FIRST') && e.campaign_id && new Date(e.occurred_at) <= new Date(o.created_at))
        .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))[0];
      if (first) slot(first.campaign_id).first += 1;
    }
    if (o.campaign_id && o.stage === 'WON' && o.closed_at && monthOf(o.closed_at) === month && o.attribution_valid !== false) slot(o.campaign_id).sales += 1;
  }
  out.outside = events.filter((e) => e.event_type === 'SALE' && e.valid && monthOf(e.occurred_at) === month && e.evidence_json.attribution === 'NAO_ATRIBUIDA' && e.evidence_json.reason === 'SEM_TOQUE_VALIDO_NA_JANELA').length;
  return out;
}

module.exports = { campaignsFromSource, costFromSource, leadsFromSource, money, cents, NIL };
