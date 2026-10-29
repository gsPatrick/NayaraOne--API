'use strict';

/**
 * M9-D627 / M9-D672 — rm_support_sla: SLA de resolução dos casos de atendimento (crm.feedback_cases) e dos chamados (construction.maintenance_cases), por mês.
 * Prioridade = a que o parâmetro analytics.sla.severidades.<prioridade> dá à severidade do caso; severidade sem prioridade vale MEDIA e é contada em
 * without_priority (a qualidade do KPI cai). SLA = horas corridas de analytics.sla.horas.<prioridade> entre a abertura (created_at) e a resolução.
 *   resolved / within_sla     casos resolvidos no mês de resolved_at (chamado: da última alteração, como a M9-D617) e os resolvidos dentro do SLA
 *   resolved_<p> / within_<p> o mesmo por prioridade ALTA, MEDIA e BAIXA (alta, media, baixa)
 *   open_overdue              casos ainda em aberto cujo prazo (abertura + horas do SLA) cai no mês e já passou, pelo relógio da passada
 * O vencimento muda sem evento: a agenda reconfere os meses de prazo dos casos em aberto e dos alterados na janela. Só contagens: descrição e pessoa não entram.
 */
const { MONTH_RE, sqlMonth, TZ, monthKey, rows } = require('./marketingAtendimento.time');
const { readSlaPolicy, PRIORITIES } = require('./atendimentoKpi.settings');

const DUE = "(created_at + hours * interval '1 hour')"; // prazo do SLA: abertura + horas da prioridade
const MAINTENANCE_DONE = "('RESOLVED', 'CLOSED')";

/** SQL e replacements dos casos classificados por prioridade, com as horas do SLA da empresa. */
function casesSql(policy) {
  const replacements = { hoursAlta: policy.hours.ALTA, hoursMedia: policy.hours.MEDIA, hoursBaixa: policy.hours.BAIXA, sevAlta: policy.severities.ALTA, sevMedia: policy.severities.MEDIA, sevBaixa: policy.severities.BAIXA };
  const sql = `WITH cases AS (
      SELECT created_at, updated_at, resolved_at AS done_at, (status = 'RESOLVED') AS finished, upper(severity) AS sev FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL
      UNION ALL
      SELECT created_at, updated_at, CASE WHEN status IN ${MAINTENANCE_DONE} THEN updated_at END, (status IN ${MAINTENANCE_DONE}), upper(severity) FROM construction.maintenance_cases WHERE company_id = :companyId AND deleted_at IS NULL
    ), timed AS (
      SELECT *, CASE WHEN sev IN (:sevAlta) THEN 'ALTA' WHEN sev IN (:sevMedia) THEN 'MEDIA' WHEN sev IN (:sevBaixa) THEN 'BAIXA' ELSE 'SEM' END AS prio,
             CASE WHEN sev IN (:sevAlta) THEN :hoursAlta WHEN sev IN (:sevBaixa) THEN :hoursBaixa ELSE :hoursMedia END AS hours FROM cases
    )`;
  return { sql, replacements };
}

function slaKey(event) {
  const p = event.payloadJson || event.payload || {};
  const month = event.eventType === 'crm.feedback_case.resolved' ? monthKey(p.resolvedAt || event.occurredAt) : monthKey(p.slaDueAt || event.occurredAt);
  return MONTH_RE.test(String(month)) ? { month } : null;
}

const within = (extra = '') => `finished AND done_at IS NOT NULL AND ${sqlMonth('done_at')} = :month AND done_at <= ${DUE}${extra}`;
const resolvedOf = (extra = '') => `finished AND done_at IS NOT NULL AND ${sqlMonth('done_at')} = :month${extra}`;
const count = (filter, name) => `count(*) FILTER (WHERE ${filter})::int AS ${name}`;

async function slaRecompute({ companyId, groupId, key, now, transaction }) {
  const { sql, replacements } = casesSql(await readSlaPolicy({ companyId, groupId }, transaction));
  const byPriority = PRIORITIES.flatMap((p) => [count(resolvedOf(` AND prio = '${p}'`), `resolved_${p.toLowerCase()}`), count(within(` AND prio = '${p}'`), `within_${p.toLowerCase()}`)]);
  const [r] = await rows(
    `${sql} SELECT ${[count(resolvedOf(), 'resolved'), count(within(), 'within_sla'), ...byPriority, count(resolvedOf(" AND prio = 'SEM'"), 'without_priority'),
      count(`NOT finished AND ${sqlMonth(DUE)} = :month AND ${DUE} < :now`, 'open_overdue')].join(', ')} FROM timed`,
    { ...TZ, ...replacements, companyId, month: key.month, now }, transaction
  );
  const { resolved, within_sla: withinSla, open_overdue: openOverdue, without_priority: withoutPriority } = r;
  const fields = { resolved, within_sla: withinSla, open_overdue: openOverdue, without_priority: withoutPriority };
  for (const p of PRIORITIES.map((x) => x.toLowerCase())) { fields[`resolved_${p}`] = r[`resolved_${p}`]; fields[`within_${p}`] = r[`within_${p}`]; }
  return { fields };
}

/** Meses de resolução (os alterados na janela, quando houver) e meses de prazo de todos os casos ainda em aberto. */
const keysSql = (sql, filter) => `${sql}
  SELECT ${sqlMonth('done_at')} AS month FROM timed WHERE finished AND done_at IS NOT NULL ${filter}
  UNION
  SELECT ${sqlMonth(DUE)} AS month FROM timed WHERE NOT finished
  ORDER BY 1`;

async function monthKeys({ companyId, groupId, since, limit, transaction }) {
  const { sql, replacements } = casesSql(await readSlaPolicy({ companyId, groupId }, transaction));
  const filter = since ? 'AND updated_at >= :since' : '';
  return rows(`${keysSql(sql, filter)} ${limit ? 'LIMIT :limit' : ''}`, { ...TZ, ...replacements, companyId, since, limit }, transaction);
}

const slaScheduled = ({ companyId, groupId, now, windowDays, limit, transaction }) => monthKeys({ companyId, groupId, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000, transaction });
const slaRebuild = ({ companyId, groupId, transaction }) => monthKeys({ companyId, groupId, transaction });

const sla = {
  name: 'rm_support_sla', keyColumns: ['month'], aggregateKey: slaKey, recompute: slaRecompute, scheduledKeys: slaScheduled, rebuildKeys: slaRebuild,
  eventTypes: ['crm.feedback_case.created', 'crm.feedback_case.resolved', 'crm.feedback_case.escalated'], // chamados de manutenção não têm evento no catálogo do M9-D434: entram pela agenda
};

module.exports = { sla, casesSql };
