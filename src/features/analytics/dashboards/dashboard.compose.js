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
const { withReasons } = require('./dashboard.banner.detail');
const { evaluateBlock } = require('../quality/status.block');
const { defaultPeriodOf } = require('../metrics/query.period');
const { isMatrix, matrixCodes, composeMatrix, bannerViewsOf } = require('./dashboard.matrix');
const { resolveAlertLimit, passesLimit } = require('./dashboard.alertLimit');

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
  const view = buildBody(w.widget_type, config, metric, dimensions, orderList);
  if (config.alertLimit) { // M9-D626: o cartão acende pelo limiar do alerta publicado (ou do parâmetro), nunca por valor fixo
    const limit = await resolveAlertLimit(ctx, w.metric_code, config.alertLimit, transaction);
    view.alert = passesLimit(metric.value, limit);
    view.alertLimit = limit;
  }
  if (isMatrix(config)) view.matrix = await composeMatrix(ctx, w, shared, transaction);
  return { ...base, metric, drilldown, view };
}

/** widgets: linhas de dashboard_widgets na ordem; devolve { widgets, quality }. */
async function composeWidgets(ctx, widgets, asOfDate, transaction, period = defaultPeriodOf(asOfDate)) {
  const codes = [...new Set(widgets.filter((w) => METRIC_TYPES.has(w.widget_type) && w.metric_code).flatMap((w) => [w.metric_code, ...matrixCodes(w.config)]))];
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
  const views = bannerViewsOf(composed);
  const deferred = composed.filter((c) => c.block && c.block.deferred);
  const { banner, quality } = withReasons(buildQualityBanner(views, deferred), views, deferred);
  return { widgets: composed.map((c) => (c.type === 'QUALITY_BANNER' ? { ...c, banner } : c)), quality };
}

module.exports = { composeWidgets, toWidgetView };
