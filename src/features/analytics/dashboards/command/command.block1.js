'use strict';

/**
 * M9-D685 (3.1, bloco 1) — "O que aconteceu" na janela `analytics.centro.janela_horas`: variação relevante de cada KPI crítico contra a janela anterior de mesma
 * duração (M9-D694: o servidor calcula, ninguém mais), os três fatos do dia da M9-D710 (contratos assinados, oportunidades ganhas, pagamentos liquidados relevantes)
 * e os alertas abertos e resolvidos na janela. Só lê indicadores e instâncias de alerta.
 */
const { computeVariation } = require('../../briefs/variation.service');
const { findDefinition } = require('../../metrics/registry.read');
const { criticalCodes } = require('../../metrics/seed/criticality.table');
const { addDays } = require('../../metrics/period.dates');
const store = require('../../dashboardReadStore.service');
const { formatValue } = require('../dashboard.format');
const { formatValue: formatAlertValue } = require('../../alerts/list.format');
const { dim, isPositive, fmt } = require('./command.read');
const { makeItem, humanize } = require('./command.item');
const { FACT_CODES } = require('./command.map');

const FACTS = Object.freeze({
  'legal.contracts_signed': { type: 'CONTRATO_ASSINADO', one: 'contrato assinado', many: 'contratos assinados' },
  'crm.opportunities_won': { type: 'OPORTUNIDADE_GANHA', one: 'oportunidade ganha', many: 'oportunidades ganhas' },
  'fin.payments_settled_relevant': { type: 'PAGAMENTO_RELEVANTE', one: 'pagamento liquidado de valor relevante', many: 'pagamentos liquidados de valor relevante' },
});
const BAD_FRESHNESS = new Set(['STALE', 'EXPIRED', 'UNKNOWN']);

function factItems(env) {
  const items = [];
  for (const code of FACT_CODES) {
    const src = env.sources.get(code);
    if (!src || !src.ok || !isPositive(src.value)) continue;
    const spec = FACTS[code];
    const qty = Number(src.value);
    const amount = dim(src, 'valor_brl');
    const previous = dim(src, 'anterior_qtd');
    items.push(makeItem({
      type: spec.type, title: `${qty} ${qty === 1 ? spec.one : spec.many}`, domain: src.domain, metricCode: code, value: src.value, formatted: fmt(src, null, src.value), unit: src.unit,
      detail: `${amount !== null ? `Valor: ${formatValue('BRL', amount)}. ` : ''}${previous !== null ? `Janela anterior: ${previous}.` : ''}`.trim() || null, drilldown: true, rank: 1, sortValue: qty,
    }));
  }
  return items;
}

/** Itens de variação: KPI crítico (fora os três fatos, que têm item próprio) cuja variação ultrapassa a relevância. Qualidade ruim em qualquer ponta: sem item. */
async function variationItems(env, tx) {
  const { ctx, asOfDate, params } = env;
  const days = Math.max(1, Math.ceil(env.windowHours / 24));
  const current = { startDate: asOfDate, endDate: asOfDate, asOfDate };
  const previousDate = addDays(asOfDate, -days);
  const previous = { startDate: previousDate, endDate: previousDate, asOfDate: previousDate };
  const codes = criticalCodes().filter((c) => !FACT_CODES.includes(c));
  const metas = await store.listMetricMeta(codes, tx);
  const items = [];
  for (const meta of metas) {
    let definition;
    try { definition = await findDefinition(meta.metricCode, tx); } catch (err) { if (err.code === 'ANALYTICS_METRIC_NOT_FOUND') continue; throw err; }
    const out = await computeVariation({ ctx, definition, companyId: ctx.companyId, periodCurrent: current, periodPrevious: previous }, tx);
    const v = out.variation;
    if (!v || [out.current, out.previous].some((r) => !r || r.status !== 'OK' || (r.freshness && BAD_FRESHNESS.has(r.freshness.state)))) continue;
    const relevant = v.percent === null ? Number(v.absolute) !== 0 : Math.abs(Number(v.percent)) > params.relevancePct;
    if (!relevant) continue;
    const up = Number(v.absolute) > 0;
    const unit = out.current.unit;
    items.push(makeItem({
      type: 'VARIACAO_KPI', title: `${definition.name}: ${up ? 'subiu' : 'caiu'}${v.percent === null ? '' : ` ${String(Math.abs(Number(v.percent))).replace('.', ',')}%`}`, domain: definition.domain, metricCode: meta.metricCode,
      detail: `De ${formatValue(unit, v.previous)} para ${formatValue(unit, v.current)} (janela anterior: ${previousDate}).${v.versionChanged ? ' A fórmula mudou entre os períodos.' : ''}`,
      value: v.current, formatted: formatValue(unit, v.current), unit, drilldown: true, rank: 2, sortValue: v.percent === null ? 1e12 : Math.abs(Number(v.percent)),
      extra: { metric: { metricCode: meta.metricCode, value: v.current, status: out.current.status, freshness: out.current.freshness } },
    }));
  }
  return items;
}

const inWindow = (date, w) => date && new Date(date) >= w.from && new Date(date) < w.to;

function alertItems(env) {
  const items = [];
  for (const a of env.alerts) {
    const opened = inWindow(a.openedAt, env.window);
    const resolved = a.status === 'RESOLVED' && inWindow(a.resolvedAt, env.window);
    if (!opened && !resolved) continue;
    const value = formatAlertValue(a.lastValue, a.unit);
    items.push(makeItem({
      type: resolved ? 'ALERTA_RESOLVIDO' : 'ALERTA_ABERTO', alert: { id: a.id, code: a.alertCode }, alertMetricCode: a.metricCode, domain: a.domain,
      severity: resolved ? 'INFO' : a.severity, title: `${resolved ? 'Alerta resolvido' : 'Alerta aberto'}: ${humanize(a.alertCode)}`,
      detail: value ? `Último valor: ${value}.` : null, href: env.alertHref(a.id), rank: 3, sortValue: new Date(a.openedAt).getTime(),
    }));
  }
  return items;
}

async function buildAconteceu(env, tx) {
  return [...factItems(env), ...await variationItems(env, tx), ...alertItems(env)];
}

module.exports = { buildAconteceu };
