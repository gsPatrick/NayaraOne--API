'use strict';

// Apoio da M9-D631: recalcula os KPIs do funil "do zero" só com as linhas-fonte do CRM (conexão de superusuário), sem usar read model, worker nem
// fórmula. Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; contas em decimal exato (money.js) e arredondadas uma vez, no fim.
const money = require('../../../src/features/analytics/metrics/formulas/money');

const CLOSED = ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN'];
const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

async function load(env, t) {
  const [opps] = await env.admin.query(
    'SELECT id, stage, owner_user_id, lost_reason, closed_at, updated_at, next_action, next_action_due_at FROM crm.opportunities WHERE company_id = :c AND deleted_at IS NULL', { replacements: { c: t.companyId } }
  );
  const [messages] = await env.admin.query('SELECT opportunity_id, created_at FROM crm.messages WHERE company_id = :c', { replacements: { c: t.companyId } });
  const [tasks] = await env.admin.query('SELECT related_entity_id, status, due_at FROM core.tasks WHERE company_id = :c AND deleted_at IS NULL', { replacements: { c: t.companyId } });
  return { opps, messages, tasks };
}

const closedInMonth = (o, asOf) => CLOSED.includes(o.stage) && o.closed_at && spDate(o.closed_at).slice(0, 7) === asOf.slice(0, 7);

/** Funil: em aberto por estágio (com a média de dias sem movimento) mais os terminais fechados no mês de SP da data-base. */
async function stagesFromSource(env, t, asOf) {
  const { opps, messages } = await load(env, t);
  const out = {};
  for (const o of opps.filter((x) => !CLOSED.includes(x.stage))) {
    const last = Math.max(new Date(o.updated_at).getTime(), ...messages.filter((m) => m.opportunity_id === o.id).map((m) => new Date(m.created_at).getTime()));
    const cell = out[o.stage] || (out[o.stage] = { count: 0, idle: 0 });
    cell.count += 1;
    cell.idle += Math.max(0, daysBetween(spDate(last), asOf));
  }
  for (const stage of CLOSED) out[stage] = { count: opps.filter((o) => o.stage === stage && closedInMonth(o, asOf)).length, idle: 0 };
  const total = Object.values(out).reduce((a, c) => a + c.count, 0);
  const avgIdle = Object.fromEntries(Object.entries(out).filter(([s, c]) => !CLOSED.includes(s) && c.count > 0).map(([s, c]) => [s, money.round(money.div(c.idle, c.count), 1)]));
  return { total: String(total), counts: Object.fromEntries(Object.entries(out).map(([s, c]) => [s, c.count])), avgIdle };
}

/** Conversão e motivos de perda do mês de SP da data-base. */
async function outcomesFromSource(env, t, asOf) {
  const { opps } = await load(env, t);
  const won = opps.filter((o) => o.stage === 'CLOSED_WON' && closedInMonth(o, asOf)).length;
  const lostList = opps.filter((o) => o.stage === 'CLOSED_LOST' && closedInMonth(o, asOf));
  const byReason = {};
  for (const o of lostList) byReason[String(o.lost_reason || '').trim() || 'NAO_INFORMADO'] = (byReason[String(o.lost_reason || '').trim() || 'NAO_INFORMADO'] || 0) + 1;
  const closed = won + lostList.length;
  return {
    won, lost: lostList.length, conversion: closed ? money.percent(won, closed).value : null, byReason,
    reasonPercent: Object.fromEntries(Object.entries(byReason).map(([k, n]) => [k, money.percent(n, lostList.length).value])),
  };
}

/** Carteira em aberto sem próxima ação válida: sem (texto e data) e sem tarefa aberta com vencimento a partir de `dueFrom` (instante ISO). */
async function portfolioFromSource(env, t, dueFrom) {
  const { opps, tasks } = await load(env, t);
  const open = opps.filter((o) => !CLOSED.includes(o.stage));
  const valid = (o) => (String(o.next_action || '').trim() !== '' && o.next_action_due_at)
    || tasks.some((k) => k.related_entity_id === o.id && !['DONE', 'CANCELED'].includes(k.status) && k.due_at && new Date(k.due_at) >= new Date(dueFrom));
  const without = open.filter((o) => !valid(o));
  const byStage = {};
  for (const o of without) byStage[o.stage] = (byStage[o.stage] || 0) + 1;
  return { open: String(open.length), without: String(without.length), percent: open.length ? money.percent(without.length, open.length).value : null, byStage, withoutBroker: open.filter((o) => !o.owner_user_id).length };
}

module.exports = { stagesFromSource, outcomesFromSource, portfolioFromSource, spDate };
