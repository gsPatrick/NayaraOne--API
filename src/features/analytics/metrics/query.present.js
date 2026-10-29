'use strict';

/**
 * M9-D702 (3.1) — o objeto de indicador que a API entrega (rota de métrica e `metric` de cada widget de painel): a leitura do registro
 * (`readMetricAsOf`, com freshness da M9-D609 e qualidade da M9-D697) mais o nome, o texto pt-BR (`formatted`), o período, o responsável (`owner`),
 * os componentes, a variação e o caminho de detalhe. Apresenta; nenhum número é calculado aqui.
 */
const { formatValue } = require('../dashboards/dashboard.format');
const { getSourceSpec } = require('./sourceRefs.spec');
const { P, has, domainPermissionOf } = require('../security');
const { periodView } = require('./query.period');

/** Linhas do bloco `quality` no formato do livro: `checks` (os que reprovaram) e `degradedReasons` (texto curto de cada motivo). */
function qualityView(quality) {
  const q = quality || {};
  const checks = (q.degradedBy || []).map((c) => ({ checkCode: c.checkCode, checkType: c.checkType, severity: c.severity, status: c.status, readModel: c.readModel }));
  const reasons = checks.map((c) => `Verificação ${c.checkCode} reprovada.`);
  for (const c of q.inheritedFrom || []) reasons.push(`Componente ${c.metricCode} em ${c.status}.`);
  return { ...q, checks, degradedReasons: reasons };
}

/** Componentes de um indicador composto com o estado que cada um tem (os que não aparecem em `inheritedFrom` estão OK). */
function componentsOf(metricCode, quality) {
  const spec = getSourceSpec(metricCode);
  if (!spec || !Array.isArray(spec.components)) return [];
  const bad = new Map(((quality && quality.inheritedFrom) || []).map((c) => [c.metricCode, c.status]));
  return spec.components.map((code) => ({ metricCode: code, status: bad.get(code) || 'OK' }));
}

/** `enabled`: o indicador tem detalhe (CRITICAL ou habilitado, com origem); `allowed`: o usuário pode abri-lo (analytics:drilldown + permissão do domínio). */
function drilldownOf(ctx, definition, sourceRefs, domainMap) {
  const enabled = Boolean(definition && (definition.criticality === 'CRITICAL' || definition.drilldown_enabled === true)) && Array.isArray(sourceRefs) && sourceRefs.length > 0;
  const allowed = enabled && has(ctx, P.DRILLDOWN) && has(ctx, domainPermissionOf(domainMap, definition.domain));
  return { enabled, allowed };
}

/** Objeto de indicador do contrato 3.1. `raw` é o retorno de readMetricAsOf; `variation` é o bloco de comparação ou null. */
function presentMetric({ ctx, definition, raw, period, asOfDate, domainMap, variation = null }) {
  return {
    ...raw,
    name: definition.name,
    formatted: formatValue(raw.unit, raw.value),
    period: periodView(period, asOfDate),
    quality: qualityView(raw.quality),
    components: componentsOf(raw.metricCode, raw.quality),
    variation,
    drilldown: drilldownOf(ctx, definition, raw.sourceRefs, domainMap),
    owner: definition.owner_role,
  };
}

module.exports = { presentMetric, qualityView, componentsOf, drilldownOf };
