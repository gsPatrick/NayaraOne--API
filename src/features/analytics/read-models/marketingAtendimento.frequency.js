'use strict';

/**
 * M9-D627 — rm_mkt_frequency: por dia (SP), contatos alcançados (pessoas que receberam mensagem automática aceita pelo provedor) e contatos
 * acima do teto de frequência. O teto é o global do Marketing (marketing.frequency_cap.global: N mensagens por M dias, por pessoa, canal e
 * finalidade); está "acima" quem, no fim do dia, tem MAIS de N mensagens contadas na janela de M dias em algum par canal/finalidade. Só ids
 * e contagens: a pessoa é identificada no drill-down com permissão. M9-D671 acrescenta a janela de frequência do BI (analytics.frequencia.janela_dias,
 * padrão 7): mensagens de automação ou campanha aceitas pelo provedor e pessoas distintas na janela que termina no dia, por canal, e as mensagens sem
 * destinatário identificável. A agenda recalcula também o dia de hoje, mesmo sem mensagem nele, quando a empresa tem mensagem na janela (a janela anda com o relógio).
 */
const { readFrequencyWindowDays } = require('./marketingKpi.settings');
const clock = require('../metrics/clock');
const { COUNTED_STATUSES, readFrequencyCap } = require('./marketingAtendimento.statuses');
const { DAY_RE, sqlDay, TZ, dayKey, dayBounds, rows } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['crm.interaction.recorded', 'crm.message.status_changed']);

function aggregateKey(event) {
  const p = event.payloadJson || event.payload || {};
  if (event.eventType === 'crm.interaction.recorded') return String(p.direction || '').toUpperCase() === 'OUTBOUND' ? { day: dayKey(event.occurredAt) } : null;
  return DAY_RE.test(String(p.day || '')) ? { day: p.day } : null;
}

async function recompute({ companyId, groupId, key, transaction }) {
  const cap = await readFrequencyCap({ companyId, groupId }, transaction);
  const { start, end } = dayBounds(key.day);
  const windowStart = new Date(end.getTime() - cap.days * 86400000);
  const base = { companyId, start, end, windowStart, counted: COUNTED_STATUSES, cap: cap.messages };
  const [reached] = await rows(
    `SELECT count(DISTINCT person_id)::int AS n FROM crm.messages
      WHERE company_id = :companyId AND direction = 'OUTBOUND' AND purpose IS NOT NULL AND person_id IS NOT NULL AND status IN (:counted) AND created_at >= :start AND created_at < :end`,
    base, transaction
  );
  const [over] = await rows(
    `SELECT count(DISTINCT p.person_id)::int AS n FROM (
        SELECT DISTINCT person_id, channel, purpose FROM crm.messages
         WHERE company_id = :companyId AND direction = 'OUTBOUND' AND purpose IS NOT NULL AND person_id IS NOT NULL AND status IN (:counted) AND created_at >= :start AND created_at < :end
      ) p
      WHERE (SELECT count(*) FROM crm.messages m WHERE m.company_id = :companyId AND m.direction = 'OUTBOUND' AND m.person_id = p.person_id AND m.channel = p.channel
                AND m.purpose = p.purpose AND m.status IN (:counted) AND m.created_at >= :windowStart AND m.created_at < :end) > :cap`,
    base, transaction
  );
  return { fields: { contacts_reached: reached.n, contacts_over_cap: over.n, ...(await windowFields({ companyId, groupId, end, counted: COUNTED_STATUSES }, transaction)) } };
}

/** Janela de frequência do BI: mensagens de automação/campanha (action_key) aceitas, pessoas distintas, sem destinatário e por canal. */
async function windowFields({ companyId, groupId, end, counted }, transaction) {
  const days = await readFrequencyWindowDays({ companyId, groupId }, transaction);
  const params = { companyId, counted, end, windowStart: new Date(end.getTime() - days * 86400000) };
  const byChannel = await rows(
    `SELECT channel, count(*)::int AS messages, count(DISTINCT person_id)::int AS people, count(*) FILTER (WHERE person_id IS NULL)::int AS unidentified
       FROM crm.messages WHERE company_id = :companyId AND direction = 'OUTBOUND' AND action_key IS NOT NULL AND status IN (:counted) AND created_at >= :windowStart AND created_at < :end GROUP BY channel`,
    params, transaction
  );
  const [total] = await rows(
    `SELECT count(DISTINCT person_id)::int AS people FROM crm.messages
      WHERE company_id = :companyId AND direction = 'OUTBOUND' AND action_key IS NOT NULL AND person_id IS NOT NULL AND status IN (:counted) AND created_at >= :windowStart AND created_at < :end`,
    params, transaction
  );
  const sum = (field) => byChannel.reduce((acc, r) => acc + r[field], 0);
  return {
    window_days: days, window_messages: sum('messages'), window_people: total.people, unidentified: sum('unidentified'),
    by_channel: Object.fromEntries(byChannel.map((r) => [r.channel, { messages: r.messages, people: r.people }])),
  };
}

const KEYS_SQL = (filter) => `SELECT DISTINCT ${sqlDay('created_at')} AS day FROM crm.messages WHERE company_id = :companyId AND direction = 'OUTBOUND' ${filter} ORDER BY 1`;

/** Os dias com mensagem na janela de reconferência mais o dia de hoje, quando a empresa tem mensagem na janela (a janela de frequência anda com o relógio; empresa sem mensagem não ganha linha). */
const withToday = (list, now) => (!list.length || list.some((r) => r.day === dayKey(now)) ? list : [...list, { day: dayKey(now) }]);

async function scheduledKeys({ companyId, now, windowDays, limit, transaction }) {
  const since = new Date(now.getTime() - windowDays * 86400000);
  return withToday(await rows(`${KEYS_SQL('AND created_at >= :since')} LIMIT :limit`, { ...TZ, companyId, since, limit: limit || 5000 }, transaction), now);
}

async function rebuildKeys({ companyId, transaction }) {
  return withToday(await rows(KEYS_SQL(''), { ...TZ, companyId }, transaction), clock.now());
}

module.exports = { name: 'rm_mkt_frequency', keyColumns: ['day'], eventTypes: EVENTS, aggregateKey, recompute, scheduledKeys, rebuildKeys };
