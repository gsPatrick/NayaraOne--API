'use strict';

// Oráculo da M9-D710: refaz cada número só com as linhas-fonte (contratos, assinaturas, oportunidades, propostas e lançamentos), por consulta direta às tabelas de origem, sem passar por
// read model nem fórmula. A janela é dada em instantes: atual [from, to] e anterior [previousFrom, from). Dinheiro em centavos inteiros (BigInt).
const cents = (text) => {
  if (text === null || text === undefined) return 0n;
  const [whole, fraction = ''] = String(text).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
};
const brl = (value) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const BASE_NOW = new Date('2026-10-28T15:00:00Z');
const HOUR = 3600 * 1000;

/** Janela móvel de hoje terminando em `now` (inclusive) com `hours` de duração. */
const windowEndingAt = (now, hours) => ({ from: new Date(now.getTime() - hours * HOUR), to: now, previousFrom: new Date(now.getTime() - 2 * hours * HOUR), closedEnd: true });
/** Janela de uma data passada: termina às 00:00 do dia seguinte de São Paulo (03:00Z), exclusivo. */
const windowOfPastDay = (day, hours) => {
  const to = new Date(Date.parse(`${day}T00:00:00Z`) + 24 * HOUR + 3 * HOUR);
  return { from: new Date(to.getTime() - hours * HOUR), to, previousFrom: new Date(to.getTime() - 2 * hours * HOUR), closedEnd: false };
};
const inCurrent = (at, w) => at !== null && at >= w.from && (w.closedEnd ? at <= w.to : at < w.to);
const inPrevious = (at, w) => at !== null && at >= w.previousFrom && at < w.from;

function totals(list, w, valueOf) {
  const sum = (items) => items.reduce((acc, i) => acc + cents(valueOf(i)), 0n);
  const now = list.filter((i) => inCurrent(i.at, w));
  const before = list.filter((i) => inPrevious(i.at, w));
  return { count: now.length, amount: brl(sum(now)), previous: { count: before.length, amount: brl(sum(before)) }, items: now };
}

async function contractsFromSource(env, t, w) {
  const [rows] = await env.admin.query(
    `SELECT c.id, c.contract_type AS type, c.total_value::text AS total, (SELECT max(s.signed_at) FROM legal.signatures s JOIN legal.contract_versions v ON v.id = s.contract_version_id
        WHERE v.contract_id = c.id AND s.status = 'SIGNED') AS at
       FROM legal.contracts c WHERE c.company_id = :c AND c.deleted_at IS NULL AND c.status IN ('SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'CLOSED')`, { replacements: { c: t.companyId } }
  );
  return totals(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at) : null })), w, (r) => r.total);
}

async function opportunitiesFromSource(env, t, w) {
  const [rows] = await env.admin.query(
    `SELECT o.id, o.closed_at AS at, o.owner_user_id AS broker, o.lead_source AS origin,
            (SELECT p.value::text FROM crm.proposals p WHERE p.opportunity_id = o.id AND p.status = 'ACCEPTED' ORDER BY p.decided_at DESC LIMIT 1) AS value
       FROM crm.opportunities o WHERE o.company_id = :c AND o.deleted_at IS NULL AND o.stage = 'WON'`, { replacements: { c: t.companyId } }
  );
  const out = totals(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at) : null })), w, (r) => r.value);
  return { ...out, withoutValue: out.items.filter((r) => r.value === null).length };
}

async function paymentsFromSource(env, t, w, threshold = '10000.00') {
  const [rows] = await env.admin.query(
    `SELECT e.id, e.settled_at AS at, e.amount::text AS amount, e.is_third_party_funds AS third FROM finance.financial_entries e
      WHERE e.company_id = :c AND e.entry_type = 'DEBIT' AND e.nature = 'PAYABLE' AND e.status = 'SETTLED' AND e.settled_at IS NOT NULL`, { replacements: { c: t.companyId } }
  );
  const relevant = rows.map((r) => ({ ...r, at: new Date(r.at) })).filter((r) => cents(r.amount) >= cents(threshold));
  const own = totals(relevant.filter((r) => !r.third), w, (r) => r.amount);
  const third = totals(relevant.filter((r) => r.third), w, (r) => r.amount);
  return { ...own, thirdParty: { count: third.count, amount: third.amount } };
}

module.exports = { cents, brl, BASE_NOW, windowEndingAt, windowOfPastDay, contractsFromSource, opportunitiesFromSource, paymentsFromSource };
