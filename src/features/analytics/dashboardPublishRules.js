'use strict';

/**
 * M9-D687 (3.2) — regras da PUBLICAÇÃO de um painel, conferidas depois de travar a linha DRAFT:
 *  - nenhum widget com fórmula/SQL (422 ANALYTICS_WIDGET_FORMULA_FORBIDDEN; o gatilho do banco já barra na gravação);
 *  - o primeiro widget é a faixa de qualidade (422 ANALYTICS_DASHBOARD_NO_QUALITY_BANNER, BI-015);
 *  - a meta p95 está definida (422 ANALYTICS_DASHBOARD_NO_P95);
 *  - a `required_permission` existe no catálogo de permissões (422 ANALYTICS_DASHBOARD_PERMISSION_UNKNOWN).
 * A regra "métrica PUBLISHED" fica em dashboardStore.service (findUnpublishedMetrics).
 */
const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { hasForbiddenKey, MSG } = require('./analyticsStoreSupport');

async function loadWidgets(dashboardId, transaction) {
  const [rows] = await sequelize.query(
    'SELECT position, widget_type, metric_code, title, dimension_key, config FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position ASC',
    { replacements: { id: dashboardId }, transaction }
  );
  return rows;
}

async function assertPublishable(dash, transaction) {
  const widgets = await loadWidgets(dash.id, transaction);
  if (widgets.some((w) => hasForbiddenKey(w.config))) throw AppError.unprocessable(MSG.WIDGET_FORMULA, 'ANALYTICS_WIDGET_FORMULA_FORBIDDEN');
  if (!widgets.length || widgets[0].widget_type !== 'QUALITY_BANNER') {
    throw AppError.unprocessable('O primeiro bloco do painel deve ser a faixa de qualidade.', 'ANALYTICS_DASHBOARD_NO_QUALITY_BANNER');
  }
  if (!dash.p95_target_ms) {
    throw AppError.unprocessable('Defina a meta de tempo (p95) do painel.', 'ANALYTICS_DASHBOARD_NO_P95');
  }
  const [perm] = await sequelize.query('SELECT 1 FROM core.permissions WHERE code = :code', { replacements: { code: dash.required_permission }, transaction });
  if (!perm.length) {
    throw AppError.unprocessable('A permissão exigida pelo painel não existe no catálogo.', 'ANALYTICS_DASHBOARD_PERMISSION_UNKNOWN', { permission: dash.required_permission });
  }
  return widgets;
}

const key = (w) => `${w.position}`;
const shape = (w) => ({ type: w.widget_type, metric: w.metric_code || null, title: w.title, dimension: w.dimension_key || null });

/** Diferença de widgets entre a versão anterior e a nova (por posição): adicionados, removidos e alterados. */
function widgetDiff(before, after) {
  const prev = new Map(before.map((w) => [key(w), shape(w)]));
  const next = new Map(after.map((w) => [key(w), shape(w)]));
  const added = [...next].filter(([k]) => !prev.has(k)).map(([k, v]) => ({ position: Number(k), ...v }));
  const removed = [...prev].filter(([k]) => !next.has(k)).map(([k, v]) => ({ position: Number(k), ...v }));
  const changed = [...next].filter(([k, v]) => prev.has(k) && JSON.stringify(prev.get(k)) !== JSON.stringify(v))
    .map(([k, v]) => ({ position: Number(k), de: prev.get(k), para: v }));
  return { added, removed, changed };
}

module.exports = { loadWidgets, assertPublishable, widgetDiff };
