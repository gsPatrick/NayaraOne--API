'use strict';

/**
 * M9-D634 — compõe a resposta única do painel (M9-D702 3.2): cada widget de indicador sai com o valor pronto (objeto `metric`), o corpo do desenho
 * (`view`: fatos, séries, barras, tabela, alerta) e o caminho de detalhe (`drilldown`); a faixa de qualidade (primeiro widget) resume o painel. Lê só o
 * schema analytics (registro de métricas, snapshots e parâmetros); nada de tabela de origem (BI-012).
 */
const store = require('../dashboardReadStore.service');
const { loadDomainMap } = require('../security');
const { buildBody } = require('./dashboard.shape');
const { loadOrderList } = require('./dashboard.order');
const { readMetricView } = require('./dashboard.metricView');
const { buildQualityBanner } = require('./dashboard.banner');
const { evaluateBlock } = require('../quality/status.block');
const { defaultPeriodOf } = require('../metrics/query.period');

const METRIC_TYPES = new Set(['KPI_CARD', 'TREND', 'TABLE', 'BAR']);

function toWidgetView(w) {
  return {
    position: w.position, type: w.widget_type, metricCode: w.metric_code, dimensionKey: w.dimension_key, title: w.title,
    valueNature: w.value_nature, drilldownEnabled: w.drilldown_enabled, config: w.config,
  };
}

async function composeMetricWidget(ctx, w, shared, transaction) {
  const base = toWidgetView(w);
  const { metric, drilldown } = await readMetricView(ctx, w, shared.forMetric(w.metric_code), transaction);
  const dimensions = metric.version === null || metric.incomplete ? []
    : await store.listDimensionSnapshots({ metricCode: w.metric_code, version: metric.version, companyId: ctx.companyId, asOfDate: shared.asOfDate }, transaction);
  const config = w.config || {};
  const orderList = await loadOrderList(config.order, ctx, transaction);
  return { ...base, metric, drilldown, view: buildBody(w.widget_type, config, metric, dimensions, orderList) };
}

/** widgets: linhas de dashboard_widgets na ordem; devolve { widgets, quality }. */
async function composeWidgets(ctx, widgets, asOfDate, transaction, period = defaultPeriodOf(asOfDate)) {
  const codes = [...new Set(widgets.filter((w) => METRIC_TYPES.has(w.widget_type) && w.metric_code).map((w) => w.metric_code))];
  const metas = new Map((await store.listMetricMeta(codes, transaction)).map((m) => [m.metricCode, m]));
  const domainMap = await loadDomainMap(ctx, transaction);
  const shared = { asOfDate, forMetric: (code) => ({ asOfDate, period, meta: metas.get(code), domainMap }) };
  const composed = [];
  for (const w of widgets) {
    composed.push(METRIC_TYPES.has(w.widget_type) && w.metric_code ? await composeMetricWidget(ctx, w, shared, transaction) : toWidgetView(w));
  }
  for (const [i, w] of composed.entries()) { // M9-D697 3.4: bloco que depende de métrica ruim adia a conclusão (Centro de Comando)
    const dependsOn = !w.metric && w.config && w.config.dependsOn;
    if (Array.isArray(dependsOn) && dependsOn.length) composed[i] = { ...w, block: await evaluateBlock(ctx, dependsOn, asOfDate, transaction) };
  }
  const { banner, quality } = buildQualityBanner(composed.filter((c) => c.metric), composed.filter((c) => c.block && c.block.deferred));
  return { widgets: composed.map((c) => (c.type === 'QUALITY_BANNER' ? { ...c, banner } : c)), quality };
}

module.exports = { composeWidgets, toWidgetView };
