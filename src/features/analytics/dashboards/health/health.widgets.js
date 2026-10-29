'use strict';

/**
 * M9-D686 — os widgets do painel `health` a partir das áreas e das regras de semáforo: a faixa de qualidade e, por área, um cartão por KPI principal com
 * `config.area` e, quando há regra, `config.trafficLight`. Dado puro (sem banco): a migration publica a versão com os padrões e `applyHealthThresholds` publica a da
 * empresa com os parâmetros dela. O nome e a natureza vêm da tabela de criticidade (M9-D712); só os indicadores CRÍTICOS têm "Ver detalhe".
 */
const { QUALITY_BANNER } = require('../panels/common');
const { getCriticalityRow } = require('../../metrics/seed/criticality.table');

function kpiWidget(area, code, rule) {
  const row = getCriticalityRow(code);
  const config = { area: area.key, areaLabel: area.label };
  if (rule) config.trafficLight = { ...(rule.dimension ? { dimension: rule.dimension } : {}), ...(rule.yellow ? { yellow: rule.yellow } : {}), ...(rule.red ? { red: rule.red } : {}) };
  return { widgetType: 'KPI_CARD', metricCode: code, title: row ? row.name : code, valueNature: row ? row.valueNature : 'ACTUAL', drilldownEnabled: Boolean(row && row.criticality === 'CRITICAL'), config };
}

/** areas: [{ key, label, kpis }]; rules: Map(código -> { dimension, yellow, red }). */
function buildHealthWidgets(areas, rules) {
  return [QUALITY_BANNER, ...areas.flatMap((area) => area.kpis.map((code) => kpiWidget(area, code, rules.get(code) || null)))];
}

module.exports = { buildHealthWidgets };
