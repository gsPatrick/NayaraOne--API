'use strict';

/**
 * M9-D686 — Saúde Geral (dashboard `health`): uma linha por área com UMA cor, a PIOR entre (a) o maior alerta OPEN da área (CRITICAL = vermelho, WARNING = amarelo, INFO =
 * verde), (b) a qualidade dos indicadores da área (DEGRADED, STALE, sem registro ou sem atualização = amarelo; EXPIRED = vermelho) e (c) a regra de semáforo de cada KPI
 * (`dashboard_widgets.config.trafficLight`, versionada com o painel). Área sem dado nenhum é CINZA "Sem dados suficientes" e nunca verde; verde só com TODAS as condições
 * verdes. Área que o usuário não pode ler vira cinza "Sem acesso", sem nenhum número. Cor e texto sempre juntos. Só lê o schema analytics.
 */
const clock = require('../../metrics/clock');
const { listCriticalityRows } = require('../../metrics/seed/criticality.table');
const { loadDomainMap } = require('../../security');
const { listCommandAlerts } = require('../../commandAlertStore.service');
const { readSources, visibleTo } = require('../command/command.read');
const { COLORS, NO_DATA_TEXT, NO_ACCESS_TEXT, lightView, worst } = require('./health.colors');
const { AREAS } = require('./health.areas');
const { ruleOfWidget, lightOf } = require('./health.rules');

const ALERT_COLOR = Object.freeze({ CRITICAL: 'VERMELHO', WARNING: 'AMARELO', INFO: 'VERDE' });
const FRESHNESS_RANK = Object.freeze({ UNKNOWN: 3, EXPIRED: 3, STALE: 2, FRESH: 1 });
const SEVERITY_TEXT = Object.freeze({ CRITICAL: 'alerta crítico aberto', WARNING: 'alerta de atenção aberto', INFO: 'alerta informativo aberto' });

/** Cor e motivo da qualidade de UM indicador da área, ou null quando ele é confiável. */
function qualityOf(src) {
  const state = src.freshness && src.freshness.state;
  if (state === 'EXPIRED') return { color: 'VERMELHO', reason: `${src.name}: dado antigo, não use para decidir` };
  if (!src.freshness || state === 'UNKNOWN') return { color: 'AMARELO', reason: `${src.name}: ainda sem atualização` };
  if (src.status === 'DEGRADED' || src.status === 'INCOMPLETE' || !src.ok) return { color: 'AMARELO', reason: `${src.name}: dado incompleto` };
  if (src.status === 'STALE' || state === 'STALE') return { color: 'AMARELO', reason: `${src.name}: dado desatualizado` };
  return null;
}

/**
 * O indicador não tem dado ATUAL: sem registro, INCOMPLETE (nunca o DEGRADED, que tem dado mas não confiável) ou nunca atualizado (freshness UNKNOWN). Área em que nenhum
 * indicador tem dado atual é CINZA e nunca vermelha (a leitura do que é "ainda sem atualização" não é um risco medido).
 */
const hasNoData = (src) => (!src.ok && src.status !== 'DEGRADED') || !src.freshness || src.freshness.state === 'UNKNOWN';

function kpiLight(src, rule) {
  if (!rule || !src.ok) return null;
  const value = rule.dimension ? (src.dims.has(rule.dimension) ? src.dims.get(rule.dimension) : null) : src.value;
  if (value === null) return null;
  const color = lightOf(value, rule);
  return { color, reason: color === 'VERDE' ? null : `${src.name}: fora do limite do semáforo` };
}

function worstFreshness(sources) {
  let worstSrc = null;
  for (const src of sources) {
    const state = src.freshness ? src.freshness.state : 'UNKNOWN';
    if (!worstSrc || (FRESHNESS_RANK[state] || 3) > (FRESHNESS_RANK[worstSrc.freshness ? worstSrc.freshness.state : 'UNKNOWN'] || 3)) worstSrc = src;
  }
  return worstSrc ? { metricCode: worstSrc.code, state: worstSrc.freshness ? worstSrc.freshness.state : 'UNKNOWN', label: worstSrc.freshness ? worstSrc.freshness.label : 'Ainda sem atualização' } : null;
}

function areaRow(area, { widgets, sources, alerts, accessible }) {
  const base = { key: area.key, label: area.label, href: area.href, domains: area.domains };
  if (!accessible) return { ...base, noAccess: true, light: lightView('CINZA', NO_ACCESS_TEXT), summary: NO_ACCESS_TEXT, reasons: [], kpis: [], openAlerts: 0, freshness: null };
  const kpiWidgets = widgets.filter((w) => w.config && w.config.area === area.key);
  const critical = listCriticalityRows().filter((r) => r.criticality === 'CRITICAL' && area.domains.includes(r.domain)).map((r) => r.code);
  const codes = [...new Set([...kpiWidgets.map((w) => w.metricCode), ...critical])];
  const list = codes.map((c) => sources.get(c)).filter(Boolean);
  const open = alerts.filter((a) => a.status === 'OPEN' && area.domains.includes(a.domain));
  const kpis = kpiWidgets.map((w) => { const light = kpiLight(sources.get(w.metricCode), ruleOfWidget(w.config)); return { ...w, light: light ? lightView(light.color) : null }; });
  const row = { ...base, kpis, openAlerts: open.length, freshness: worstFreshness(list) };
  if (!list.length || list.every(hasNoData)) return { ...row, light: lightView('CINZA', NO_DATA_TEXT), summary: NO_DATA_TEXT, reasons: [], noData: true };
  const reasons = [];
  const colors = [];
  const topSeverity = ['CRITICAL', 'WARNING', 'INFO'].find((sev) => open.some((a) => a.severity === sev));
  if (topSeverity) { colors.push(ALERT_COLOR[topSeverity]); if (topSeverity !== 'INFO') reasons.push(`${open.filter((a) => a.severity === topSeverity).length} ${SEVERITY_TEXT[topSeverity]}`); }
  for (const src of list) {
    const quality = qualityOf(src);
    if (quality) { colors.push(quality.color); reasons.push(quality.reason); }
  }
  for (const w of kpiWidgets) {
    const light = kpiLight(sources.get(w.metricCode), ruleOfWidget(w.config));
    if (light) { colors.push(light.color); if (light.reason) reasons.push(light.reason); }
  }
  const color = worst(colors);
  return { ...row, light: lightView(color), summary: COLORS[color].text, reasons: [...new Set(reasons)] };
}

/** Acrescenta ao painel composto as linhas por área. composed = { widgets, quality }. */
async function decorateHealth(ctx, composed, { asOfDate }, tx) {
  const domainMap = await loadDomainMap(ctx, tx);
  const widgets = composed.widgets.filter((w) => w.config && w.config.area);
  const areaKeys = [...new Set(widgets.map((w) => w.config.area))];
  const areas = areaKeys.map((k) => AREAS.find((a) => a.key === k)).filter(Boolean);
  const accessible = new Map(areas.map((a) => [a.key, a.domains.every((d) => visibleTo(ctx, domainMap, d))]));
  const readable = areas.filter((a) => accessible.get(a.key));
  const critical = listCriticalityRows().filter((r) => r.criticality === 'CRITICAL' && readable.some((a) => a.domains.includes(r.domain))).map((r) => r.code);
  const sources = await readSources(ctx, [...new Set([...readable.flatMap((a) => widgets.filter((w) => w.config.area === a.key).map((w) => w.metricCode)), ...critical])], asOfDate, tx);
  const now = clock.now();
  const alerts = await listCommandAlerts({ companyId: ctx.companyId, from: new Date(0), to: new Date(now.getTime() + 1) }, tx);
  const rows = areas.map((a) => areaRow(a, { widgets, sources, alerts, accessible: accessible.get(a.key) }));
  const restricted = new Set(areas.filter((a) => !accessible.get(a.key)).map((a) => a.key));
  const safeWidgets = composed.widgets.map((w) => (w.config && restricted.has(w.config.area) ? { position: w.position, type: w.type, title: w.title, config: { area: w.config.area, areaLabel: w.config.areaLabel }, restricted: true } : w));
  return { widgets: safeWidgets, areas: rows, summary: summaryOf(rows) };
}

function summaryOf(rows) {
  const count = (color) => rows.filter((r) => r.light.color === color).length;
  return { areas: rows.length, verde: count('VERDE'), amarelo: count('AMARELO'), vermelho: count('VERMELHO'), cinza: count('CINZA') };
}

module.exports = { decorateHealth, areaRow, qualityOf };
