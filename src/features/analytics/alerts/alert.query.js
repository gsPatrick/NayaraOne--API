'use strict';

/**
 * M9-D703 (3.1) — validação da consulta de GET /analytics/alerts: `status` (lista separada por vírgula; padrão OPEN,ACKNOWLEDGED), `severity`, `metricCode`,
 * `page` e `pageSize` (máximo e padrão do administrador, o máximo nunca passa de 100). Valor inválido é 400 ANALYTICS_ALERT_QUERY_INVALID, nunca ajuste silencioso.
 */
const AppError = require('../../../utils/AppError');

const STATUSES = Object.freeze(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
const SEVERITIES = Object.freeze(['INFO', 'WARNING', 'CRITICAL']);
const DEFAULT_STATUSES = Object.freeze(['OPEN', 'ACKNOWLEDGED']);
const METRIC_CODE_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const INT_RE = /^\d{1,9}$/;
const CODE = 'ANALYTICS_ALERT_QUERY_INVALID';

const invalid = (message) => AppError.badRequest(message, CODE);
const one = (value) => (Array.isArray(value) ? value.join(',') : value);

function parseStatuses(raw) {
  if (raw === undefined || raw === '') return [...DEFAULT_STATUSES];
  const list = String(one(raw)).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.some((s) => !STATUSES.includes(s))) throw invalid(`Estado inválido. Valores aceitos: ${STATUSES.join(', ')}.`);
  return [...new Set(list)];
}

function parseInteger(raw, name, { min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  const text = String(one(raw)).trim();
  const n = INT_RE.test(text) ? Number.parseInt(text, 10) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} deve ser um inteiro de ${min} a ${max}.`);
  return n;
}

/** limits = { defaultPageSize, maxPageSize } (parâmetros do administrador). Devolve { statuses, severity, metricCode, page, pageSize }. */
function parseAlertQuery(query, limits) {
  const q = query || {};
  let severity = null;
  if (q.severity !== undefined && q.severity !== '') {
    severity = String(one(q.severity)).trim().toUpperCase();
    if (!SEVERITIES.includes(severity)) throw invalid(`Gravidade inválida. Valores aceitos: ${SEVERITIES.join(', ')}.`);
  }
  let metricCode = null;
  if (q.metricCode !== undefined && q.metricCode !== '') {
    metricCode = String(one(q.metricCode)).trim();
    if (!METRIC_CODE_RE.test(metricCode)) throw invalid('O código da métrica deve seguir o formato dominio.nome_em_snake.');
  }
  return {
    statuses: parseStatuses(q.status),
    severity,
    metricCode,
    page: parseInteger(q.page, 'page', { min: 1, max: 1000000, fallback: 1 }),
    pageSize: parseInteger(q.pageSize, 'pageSize', { min: 1, max: limits.maxPageSize, fallback: limits.defaultPageSize }),
  };
}

module.exports = { parseAlertQuery, STATUSES, SEVERITIES };
