'use strict';

// Oráculo da M9-D671: refaz cada número só com as linhas-fonte (consultas diretas ao OLTP, sem read model nem fórmula), em dias de calendário de São Paulo.
const { dayOf } = require('./m9d660Oracle');

const rows = async (env, sql, c) => (await env.admin.query(sql, { replacements: { c: c.companyId } }))[0];
const monthOf = (instant) => dayOf(instant).slice(0, 7);
const DELIVERED = ['DELIVERED', 'READ'];
const FAILED = ['FAILED', 'UNDELIVERED', 'BOUNCED'];
const COUNTED = ['SENT', 'DELIVERED', 'READ', 'UNKNOWN'];

const marketingMessages = async (env, t) => (await rows(env, "SELECT * FROM crm.messages WHERE company_id = :c AND direction = 'OUTBOUND' AND action_key IS NOT NULL", t));

async function deliveryFromSource(env, t, month) {
  const list = (await marketingMessages(env, t)).filter((m) => monthOf(m.created_at) === month);
  const by = {};
  for (const m of list) {
    const slot = by[m.channel] || (by[m.channel] = { sent: 0, delivered: 0, failed: 0, bounced: 0 });
    slot.sent += 1;
    if (DELIVERED.includes(m.status)) slot.delivered += 1;
    if (FAILED.includes(m.status)) slot.failed += 1;
    if (m.status === 'BOUNCED') slot.bounced += 1;
  }
  const sum = (f) => Object.values(by).reduce((n, v) => n + v[f], 0);
  const final = [...DELIVERED, ...FAILED];
  const awaiting = list.filter((m) => !final.includes(m.status)).map((m) => new Date(m.created_at).getTime()).sort((a, b) => a - b)[0] || null;
  return { by, sent: sum('sent'), delivered: sum('delivered'), failed: sum('failed') - sum('bounced'), bounced: sum('bounced'), awaiting };
}

/** Pessoas distintas alcançadas (mensagem aceita pelo provedor) e pedidos de saída distintos (pessoa ou endereço) por canal, no mês. */
async function optOutFromSource(env, t, month) {
  const reached = {};
  for (const m of (await marketingMessages(env, t)).filter((x) => monthOf(x.created_at) === month && x.person_id && COUNTED.includes(x.status))) (reached[m.channel] = reached[m.channel] || new Set()).add(m.person_id);
  const outs = {};
  const add = (channel, who) => (outs[channel] = outs[channel] || new Set()).add(who);
  for (const s of await rows(env, "SELECT * FROM marketing.suppression_list WHERE company_id = :c AND reason = 'OPT_OUT' AND deleted_at IS NULL", t)) if (monthOf(s.created_at) === month) add(s.channel, s.person_id ? `p:${s.person_id}` : `a:${s.address_hash}`);
  for (const k of await rows(env, "SELECT * FROM people.communication_consents WHERE company_id = :c AND status = 'OPT_OUT'", t)) if (monthOf(k.recorded_at) === month) add(k.channel, `p:${k.person_id}`);
  const channels = [...new Set([...Object.keys(reached), ...Object.keys(outs)])].sort();
  const by = Object.fromEntries(channels.map((c) => [c, { reached: (reached[c] || new Set()).size, optOuts: (outs[c] || new Set()).size }]));
  const sum = (f) => Object.values(by).reduce((n, v) => n + v[f], 0);
  return { by, reached: sum('reached'), optOuts: sum('optOuts') };
}

/** Frequência na janela de `days` dias que termina em `asOf` (inclusive): mensagens, pessoas distintas e a média; acima do teto (N por M dias, por pessoa, canal e finalidade) no dia. */
async function frequencyFromSource(env, t, asOf, days, cap = { messages: 3, days: 7 }) {
  const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const inWindow = (m, size, end) => { const n = dayNumber(dayOf(m.created_at)); return n > dayNumber(end) - size && n <= dayNumber(end); };
  const list = (await marketingMessages(env, t)).filter((m) => COUNTED.includes(m.status));
  const window = list.filter((m) => inWindow(m, days, asOf));
  const people = new Set(window.filter((m) => m.person_id).map((m) => m.person_id));
  const byChannel = {};
  for (const m of window) { const s = byChannel[m.channel] || (byChannel[m.channel] = { messages: 0, people: new Set() }); s.messages += 1; if (m.person_id) s.people.add(m.person_id); }
  const today = list.filter((m) => dayOf(m.created_at) === asOf && m.purpose && m.person_id);
  const pairs = new Set(today.map((m) => `${m.person_id}|${m.channel}|${m.purpose}`));
  const over = new Set([...pairs].filter((p) => list.filter((m) => `${m.person_id}|${m.channel}|${m.purpose}` === p && inWindow(m, cap.days, asOf)).length > cap.messages).map((p) => p.split('|')[0]));
  return { messages: window.length, people: people.size, unidentified: window.filter((m) => !m.person_id).length, over: over.size, byChannel };
}

/** Execuções do mês: iniciadas, bloqueadas (sem QUIET_HOURS) por motivo, com falha por código de erro. */
async function automationsFromSource(env, t, month) {
  const runs = await rows(env, 'SELECT * FROM marketing.automation_runs WHERE company_id = :c AND deleted_at IS NULL', t);
  const out = { total: 0, blocked: 0, failed: 0, byReason: {}, byCode: {}, withoutReason: 0 };
  for (const r of runs) {
    if (monthOf(r.started_at) === month) out.total += 1;
    const end = monthOf(r.finished_at || r.started_at);
    if (end !== month) continue;
    if (r.status === 'BLOCKED' && r.blocked_reason !== 'QUIET_HOURS') {
      out.blocked += 1;
      if (r.blocked_reason) out.byReason[r.blocked_reason] = (out.byReason[r.blocked_reason] || 0) + 1; else out.withoutReason += 1;
    }
    if (r.status === 'FAILED') {
      out.failed += 1;
      const code = (r.actions_result.find((a) => a.status === 'FAILED' && a.error_code) || {}).error_code || 'SEM_CODIGO';
      out.byCode[code] = (out.byCode[code] || 0) + 1;
    }
  }
  return out;
}

const pct = (part, total) => (Math.round((part * 10000) / total) / 100).toFixed(2);

module.exports = { deliveryFromSource, optOutFromSource, frequencyFromSource, automationsFromSource, pct };
