'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { CHANNELS } = require('../adapters/channels');
const { cadence } = require('../../automations');
const { readPageLimits } = require('./schedule.settings');
const { filterInvalid } = require('./schedule.errors');

const STATUSES = Object.freeze(['PENDING', 'RUNNING', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'CANCELLED']);

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw filterInvalid(`Informe ${field} como data e hora válida.`, { field });
  return date;
}

function parsePositive(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw filterInvalid(`Informe ${field} como número inteiro maior que zero.`, { field });
  return n;
}

/** Horário no fuso da empresa com o deslocamento (ex.: 2026-11-03T10:00:00-03:00): o livro exibe em America/Sao_Paulo. */
function formatLocal(date, zone) {
  const get = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', ...opts }).formatToParts(date);
  const p = Object.fromEntries(get({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).map((x) => [x.type, x.value]));
  const offset = (get({ timeZoneName: 'longOffset' }).find((x) => x.type === 'timeZoneName') || {}).value || 'GMT';
  const match = /GMT([+-]\d{2}:\d{2})?/.exec(offset);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${match && match[1] ? match[1] : 'Z'}`;
}

/** Métricas do último resultado (empate de tentativa e horário: vale a coleta de métricas mais recente, e o resultado da publicação só se não houver coleta): a coleta do worker (M9-D411) guarda os números em `metrics_json.metrics`; o resultado antigo guarda o objeto direto. */
const metricsOf = (r) => (r.outcome === 'METRICS' ? (r.metrics_json || {}).metrics || {} : r.metrics_json || {});

/** "Publicado" só quando o canal confirmou que está no ar (M9-D411 item 8): job PUBLISHED. Post aceito e ainda em processamento aparece como "Em processamento no canal". */
function displayStatusOf(r) {
  if (r.status === 'RUNNING' && r.provider_status) return 'Em processamento no canal';
  return { PENDING: 'Agendado', RUNNING: 'Publicando', PUBLISHED: 'Publicado', FAILED: 'Falhou', UNKNOWN: 'Sem confirmação', CANCELLED: 'Cancelado' }[r.status] || r.status;
}

/**
 * GET /marketing/publications?status=&channel=&from=&to=&page=&pageSize= (M9-D410 item 5): paginada (padrão e máximo vêm dos parâmetros da empresa),
 * ordenada por scheduled_at, com externalPostId, externalUrl e métricas do último resultado. `from`/`to` limitam scheduled_at.
 */
async function listPublications(tenant, query, transaction) {
  const q = query || {};
  const status = q.status ? String(q.status).toUpperCase() : null;
  const channel = q.channel ? String(q.channel).toUpperCase() : null;
  if (status && !STATUSES.includes(status)) throw filterInvalid('Status de publicação inválido.', { field: 'status', allowed: STATUSES });
  if (channel && !CHANNELS.includes(channel)) throw filterInvalid('Canal inválido.', { field: 'channel', allowed: CHANNELS });
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  const limits = await readPageLimits(tenant, transaction);
  const pageSize = Math.min(parsePositive(q.pageSize, 'pageSize') || limits.standard, limits.max);
  const page = parsePositive(q.page, 'page') || 1;
  const filters = ['j.deleted_at IS NULL', 'j.company_id = :companyId'];
  const replacements = { companyId: tenant.companyId, limit: pageSize, offset: (page - 1) * pageSize };
  if (status) { filters.push('j.status = :status'); replacements.status = status; }
  if (channel) { filters.push('j.channel = :channel'); replacements.channel = channel; }
  if (from) { filters.push('j.scheduled_at >= :from'); replacements.from = from.toISOString(); }
  if (to) { filters.push('j.scheduled_at <= :to'); replacements.to = to.toISOString(); }
  const where = filters.join(' AND ');
  const run = (sql) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  const [{ total }] = await run(`SELECT count(*)::int AS total FROM marketing.publication_jobs j WHERE ${where}`);
  const rows = await run(
    `SELECT j.id, j.channel, j.status, j.scheduled_at, j.attempts, j.external_post_id, j.last_error_code, j.content_version_id, v.content_item_id, i.title, j.provider_status, j.external_url AS job_url, j.escalated_at,
            r.external_url, r.metrics_json, r.outcome
       FROM marketing.publication_jobs j
       JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
       JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
       LEFT JOIN LATERAL (SELECT external_url, metrics_json, outcome FROM marketing.publication_results pr WHERE pr.job_id = j.id AND pr.company_id = j.company_id
                           ORDER BY pr.attempt_no DESC, pr.occurred_at DESC, pr.metrics_json->>'collectedAt' DESC NULLS LAST, pr.id DESC LIMIT 1) r ON true
      WHERE ${where} ORDER BY j.scheduled_at, j.id LIMIT :limit OFFSET :offset`
  );
  const zone = (await cadence.getMarketingParam(cadence.QUIET_HOURS_KEY, tenant, transaction)).timeZone; // fuso da empresa (M9-D417), padrão America/Sao_Paulo
  return {
    items: rows.map((r) => ({
      id: r.id, contentItemId: r.content_item_id, contentVersionId: r.content_version_id, title: r.title, channel: r.channel, status: r.status,
      scheduledAt: new Date(r.scheduled_at).toISOString(), scheduledAtLocal: formatLocal(new Date(r.scheduled_at), zone), timeZone: zone, attempts: r.attempts,
      externalPostId: r.external_post_id, externalUrl: r.job_url || r.external_url || null, metrics: metricsOf(r), lastErrorCode: r.last_error_code,
      providerStatus: r.provider_status || null, displayStatus: displayStatusOf(r), needsDecision: Boolean(r.escalated_at && r.status === 'UNKNOWN'),
    })),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

module.exports = { listPublications, formatLocal, STATUSES };
