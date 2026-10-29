'use strict';

// Apoio da M9-D630: recalcula os KPIs "do zero" só com as linhas-fonte do CRM (conexão de superusuário), sem usar read model, worker nem fórmula.
// Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; contas em decimal exato (money.js) e uma única vez no fim.
const money = require('../../../src/features/analytics/metrics/formulas/money');

const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function opportunities(env, t) {
  const [rows] = await env.admin.query(
    'SELECT id, lead_source, created_at, owner_user_id FROM crm.opportunities WHERE company_id = :c AND deleted_at IS NULL ORDER BY id', { replacements: { c: t.companyId } }
  );
  return rows;
}

/** Leads do mês de SP da data-base, até ela: total e, por origem (maiúsculas, vazia = NAO_INFORMADA), contagem e percentual. */
async function leadsFromSource(env, t, asOf) {
  const first = `${asOf.slice(0, 7)}-01`;
  const mine = (await opportunities(env, t)).filter((o) => spDate(o.created_at) >= first && spDate(o.created_at) <= asOf);
  const byOrigin = {};
  for (const o of mine) {
    const key = String(o.lead_source || '').trim().toUpperCase() || 'NAO_INFORMADA';
    byOrigin[key] = (byOrigin[key] || 0) + 1;
  }
  const percent = Object.fromEntries(Object.entries(byOrigin).map(([k, n]) => [k, money.percent(n, mine.length).value]));
  return { total: String(mine.length), byOrigin, percent };
}

/** Primeira resposta humana (mensagem de saída de EMPLOYEE depois da criação) de cada lead do mês: segundos inteiros e média em minutos (1 casa). */
async function firstResponseFromSource(env, t, asOf, { includeNay = false } = {}) {
  const first = `${asOf.slice(0, 7)}-01`;
  const mine = (await opportunities(env, t)).filter((o) => spDate(o.created_at) >= first && spDate(o.created_at) <= asOf);
  const [messages] = await env.admin.query(
    "SELECT opportunity_id, author_type, created_at FROM crm.messages WHERE company_id = :c AND direction = 'OUTBOUND' ORDER BY created_at", { replacements: { c: t.companyId } }
  );
  const seconds = [];
  for (const o of mine) {
    const hit = messages.find((m) => m.opportunity_id === o.id && new Date(m.created_at) >= new Date(o.created_at) && (m.author_type === 'EMPLOYEE' || (includeNay && m.author_type === 'NAY')));
    if (hit) seconds.push(Math.floor((new Date(hit.created_at) - new Date(o.created_at)) / 1000));
  }
  const average = seconds.length ? money.round(money.div(money.sum(seconds), money.mul(seconds.length, 60)), 1) : null;
  return { leads: String(mine.length), answered: String(seconds.length), withoutResponse: String(mine.length - seconds.length), seconds, average };
}

module.exports = { leadsFromSource, firstResponseFromSource, spDate };
