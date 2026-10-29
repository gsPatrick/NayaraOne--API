'use strict';

/**
 * M9-D701 (3.1) — corpo do pedido `POST /analytics/exports`: `{ target: { dashboardCode | metricCode | drilldown }, companyId | groupId, period, filters }`.
 * `drilldown` leva o filtro assinado de um item de `sourceRefs` (M9-D611): `{ metricCode, component?, filter, filterHash, filterSignature }`.
 * `period` é a data-base (AAAA-MM-DD, calendário de São Paulo; sem ele, hoje). `filters` aceita só `dimensionKeys` (recorte das séries do indicador ou
 * do painel). O resultado é o plano CONGELADO: nada além dele é gravado em `scope`/`filters` e nenhuma rota o altera.
 */
const { resolveAsOf } = require('../metrics/period');
const { invalidBody } = require('./export.errors');

const METRIC_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const DASHBOARD_RE = /^[a-z][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEYS = 100;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseTarget(target) {
  if (!isObject(target)) throw invalidBody('Informe o alvo da exportação (painel, indicador ou detalhe).');
  const given = ['dashboardCode', 'metricCode', 'drilldown'].filter((k) => target[k] !== undefined && target[k] !== null);
  if (given.length !== 1) throw invalidBody('Informe exatamente um alvo: dashboardCode, metricCode ou drilldown.');
  if (given[0] === 'dashboardCode') {
    if (typeof target.dashboardCode !== 'string' || !DASHBOARD_RE.test(target.dashboardCode)) throw invalidBody('O código do painel é inválido.');
    return { kind: 'DASHBOARD', code: target.dashboardCode };
  }
  if (given[0] === 'metricCode') {
    if (typeof target.metricCode !== 'string' || !METRIC_RE.test(target.metricCode)) throw invalidBody('O código do indicador é inválido.');
    return { kind: 'METRIC', code: target.metricCode };
  }
  const d = target.drilldown;
  if (!isObject(d) || typeof d.metricCode !== 'string' || !METRIC_RE.test(d.metricCode)) throw invalidBody('O detalhe precisa do código do indicador.');
  let filter = d.filter;
  if (typeof filter === 'string') { try { filter = JSON.parse(filter); } catch (_e) { filter = null; } }
  if (!isObject(filter) || typeof d.filterHash !== 'string' || !d.filterHash || typeof d.filterSignature !== 'string' || !d.filterSignature) {
    throw invalidBody('O detalhe precisa do filtro assinado (filter, filterHash e filterSignature).');
  }
  if (d.component !== undefined && (typeof d.component !== 'string' || !METRIC_RE.test(d.component))) throw invalidBody('O componente do detalhe é inválido.');
  return { kind: 'DRILLDOWN', code: d.metricCode, drilldown: { metricCode: d.metricCode, component: d.component || null, filter, filterHash: d.filterHash, filterSignature: d.filterSignature } };
}

function parseFilters(filters, kind) {
  if (filters === undefined || filters === null) return {};
  if (!isObject(filters)) throw invalidBody('Os filtros devem ser um objeto.');
  const unknown = Object.keys(filters).filter((k) => k !== 'dimensionKeys');
  if (unknown.length) throw invalidBody(`Filtro não aceito: ${unknown.join(', ')}.`);
  if (filters.dimensionKeys === undefined) return {};
  const keys = filters.dimensionKeys;
  if (kind === 'DRILLDOWN') throw invalidBody('O detalhe já vem recortado pelo filtro assinado; não aceita dimensionKeys.');
  if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 120)) {
    throw invalidBody(`dimensionKeys deve listar até ${MAX_KEYS} chaves de dimensão.`);
  }
  return { dimensionKeys: [...new Set(keys)].sort() };
}

function parsePeriod(period) {
  if (period === undefined || period === null || period === '') return resolveAsOf(undefined);
  const text = isObject(period) ? period.asOf : period;
  if (typeof text !== 'string') throw invalidBody('O período deve ser a data-base AAAA-MM-DD.');
  return resolveAsOf(text);
}

/** { kind, code, drilldown?, level, companyId|groupId (como pedido), asOfDate, filters } ou 400 ANALYTICS_EXPORT_INVALID. */
function parseExportBody(body) {
  const b = isObject(body) ? body : {};
  const target = parseTarget(b.target);
  if (b.companyId !== undefined && b.groupId !== undefined) throw invalidBody('Informe a empresa ou o grupo, não os dois.');
  for (const key of ['companyId', 'groupId']) {
    if (b[key] !== undefined && (typeof b[key] !== 'string' || !UUID_RE.test(b[key]))) throw invalidBody(`${key} inválido.`);
  }
  const level = b.groupId !== undefined ? 'GROUP' : 'COMPANY';
  if (level === 'GROUP' && target.kind !== 'METRIC') throw invalidBody('A exportação do grupo vale só para indicador.');
  return { ...target, level, companyId: b.companyId, groupId: b.groupId, asOfDate: parsePeriod(b.period), filters: parseFilters(b.filters, target.kind) };
}

module.exports = { parseExportBody };
