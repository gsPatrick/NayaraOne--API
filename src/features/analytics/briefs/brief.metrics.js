'use strict';

/**
 * M9-D693 (3.2 a, 3.5) — as métricas que a NAY Diretoria pode receber para um briefing: as dos painéis PUBLICADOS que o papel da diretoria da
 * empresa vê (audiência do painel vazia ou com o papel; permissão do painel e do domínio da métrica dentro das permissões da diretoria), já
 * calculadas, com versão, frescor, estado e variação contra o período anterior (M9-D694). O briefing é único por empresa, tipo e período:
 * por isso a entrada usa as permissões do PAPEL (parâmetros `analytics.brief.papel` e `analytics.brief.dominios`), nunca as de quem lê;
 * quem lê é filtrado só na exibição (brief.read.js). Métrica sem registro na data-base não entra (fica no resumo de qualidade como sem dado).
 */
const { findDefinition, readMetricAsOf, clock } = require('../metrics');
const readStore = require('../briefReadStore.service');
const { P, has, loadDomainMap, domainPermissionOf } = require('../security');
const { evaluateBlock } = require('../quality/status.block');
const { computeVariation } = require('./variation.service');
const { areaOf, norm } = require('./brief.areas');

const BAD_STATUS = new Set(['STALE', 'DEGRADED', 'INCOMPLETE']);
const BAD_FRESHNESS = new Set(['STALE', 'EXPIRED', 'UNKNOWN']);

/** Contexto do papel da diretoria: sem usuário, com a permissão do BI e a de leitura de cada área permitida pelo administrador. */
async function directorContext(scope, params, transaction) {
  const base = { groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, permissions: [P.READ] };
  const map = await loadDomainMap(base, transaction);
  const permissions = new Set([P.READ]);
  for (const domain of params.domains) permissions.add(domainPermissionOf(map, domain));
  if (params.domains.includes('TECH_AI')) permissions.add(P.READ_TECH);
  return { ...base, permissions: [...permissions], domainMap: map };
}

/** Motivo de qualidade que impede concluir sobre a leitura (status gravado ou frescor), ou null. */
function qualityReason(read) {
  if (!read) return null;
  if (BAD_STATUS.has(read.status)) return read.status;
  if (read.freshness && BAD_FRESHNESS.has(read.freshness.state)) return read.freshness.state;
  return null;
}

const audienceOk = (audience, role) => !Array.isArray(audience) || audience.length === 0 || audience.some((r) => norm(r) === norm(role));

async function visibleWidgets(ctx, scope, params, transaction) {
  const rows = await readStore.listPublishedMetricWidgets(scope, transaction);
  return rows.filter((w) => audienceOk(w.audienceRoles, params.role) && has(ctx, w.requiredPermission));
}

const sourceOf = (read) => ({
  metricCode: read.metricCode, version: read.version, sourceSnapshotAt: read.sourceSnapshotAt ? new Date(read.sourceSnapshotAt).toISOString() : null,
  freshnessState: read.freshness.state,
});

/** Um item por métrica visível: { metricCode, name, domain, area, unit, current, previous, variation, trafficLight, quality, polarity, source }. */
async function collectMetricFacts({ ctx, scope, params, periods }, transaction) {
  const widgets = await visibleWidgets(ctx, scope, params, transaction);
  const config = new Map();
  for (const w of widgets) if (!config.has(w.metricCode) || (w.config && w.config.trafficLight)) config.set(w.metricCode, w.config || {});
  const facts = [];
  const noData = [];
  for (const code of config.keys()) {
    let definition;
    try { definition = await findDefinition(code, transaction); } catch (err) { if (err.code === 'ANALYTICS_METRIC_NOT_FOUND') continue; throw err; }
    if (definition.status !== 'PUBLISHED' || !has(ctx, domainPermissionOf(ctx.domainMap, definition.domain))) continue;
    const out = await computeVariation({ ctx, definition, companyId: scope.companyId, periodCurrent: periods.current, periodPrevious: periods.previous }, transaction);
    if (!out.current) { noData.push({ metricCode: code, domain: definition.domain }); continue; }
    const quality = qualityReason(out.current);
    facts.push({
      metricCode: code, name: definition.name, domain: definition.domain, area: areaOf(definition.domain), unit: out.current.unit, current: out.current,
      previous: out.previous, variation: quality || qualityReason(out.previous) ? null : out.variation,
      trafficLight: (config.get(code) || {}).trafficLight || null, quality, polarity: params.polarity.get(code) || null, source: sourceOf(out.current),
    });
  }
  return { facts, noData };
}

/**
 * Portão de qualidade por ÁREA (M9-D697 `evaluateBlock`): com qualquer indicador da área DEGRADED, INCOMPLETE (inclui sem registro) ou STALE, a área
 * não recebe conclusão no briefing. Marca `quality` e tira a variação de todos os indicadores da área e devolve Map(domínio -> portão) das adiadas.
 */
async function applyAreaGates({ ctx, facts, noData, asOfDate }, transaction) {
  const byDomain = new Map();
  for (const { metricCode, domain } of [...facts, ...noData]) byDomain.set(domain, [...(byDomain.get(domain) || []), metricCode]);
  const deferred = new Map();
  for (const [domain, codes] of byDomain) {
    const gate = await evaluateBlock(ctx, codes, asOfDate, transaction);
    if (gate.deferred) deferred.set(domain, gate);
  }
  for (const fact of facts) {
    const gate = deferred.get(fact.domain);
    if (!gate) continue;
    const own = gate.reasons.find((r) => r.metricCode === fact.metricCode);
    fact.quality = fact.quality || (own ? own.problem : 'AREA_ADIADA');
    fact.variation = null;
  }
  return deferred;
}

/**
 * Fonte dos alertas cuja métrica não tem registro na data-base do período (por exemplo, um alerta de dado velho): vale o registro mais
 * recente de hoje. Assim um alerta CRITICAL nunca some do briefing só porque o indicador não foi gravado naquele dia. Map(metricCode -> fonte).
 */
async function alertFallbackSources({ ctx, scope, alerts, facts }, transaction) {
  const known = new Set(facts.map((f) => f.metricCode));
  const sources = new Map();
  for (const code of new Set(alerts.filter((a) => a.status !== 'RESOLVED').map((a) => a.metricCode))) {
    if (known.has(code)) continue;
    try {
      const read = await readMetricAsOf(ctx, { metricCode: code, scopeType: 'COMPANY', scopeId: scope.companyId, asOfDate: clock.businessToday() }, transaction);
      sources.set(code, sourceOf(read));
    } catch (err) {
      if (err.code !== 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE' && err.code !== 'ANALYTICS_METRIC_NOT_FOUND') throw err;
    }
  }
  return sources;
}

module.exports = { directorContext, collectMetricFacts, applyAreaGates, alertFallbackSources, qualityReason, sourceOf };
