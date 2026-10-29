'use strict';

/** Blocos comuns aos painéis (M9-D697: a faixa de qualidade é SEMPRE o primeiro widget) e construtores de widget. */
const QUALITY_BANNER = Object.freeze({ widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados', valueNature: 'ACTUAL', drilldownEnabled: false, config: {} });

const widget = (widgetType) => (metricCode, title, config = {}, valueNature = 'ACTUAL') => ({ widgetType, metricCode, title, valueNature, drilldownEnabled: true, config });
const card = widget('KPI_CARD');
const bars = widget('BAR');
const table = widget('TABLE');

module.exports = { QUALITY_BANNER, card, bars, table };
