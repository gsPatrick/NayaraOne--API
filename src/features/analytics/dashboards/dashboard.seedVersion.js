'use strict';

/**
 * M9-D634 / M9-D662 — publica o CONTEÚDO de um painel do catálogo como nova versão da definição GLOBAL (a definição publicada é imutável por gatilho:
 * M9-D601). Usado pelas migrations de painel: retira a versão vigente, cria a seguinte em DRAFT com os widgets e a publica, tudo numa transação com
 * `app.analytics_writer` ligado. Idempotente: se os widgets vigentes já são estes, não faz nada. `down` apaga a versão criada e republica a anterior
 * (gatilhos desligados só dentro da transação, como o down da 9687). Recebe o `queryInterface` da migration: esta camada não importa o banco.
 */
const ZERO_SCOPE = 'company_id IS NULL AND group_id IS NULL';
const COLUMNS = ['position', 'widget_type', 'metric_code', 'dimension_key', 'title', 'value_nature', 'drilldown_enabled', 'config'];

const fromDefinition = (w, position) => ({
  position, widget_type: w.widgetType, metric_code: w.metricCode || null, dimension_key: w.dimensionKey || null, title: w.title,
  value_nature: w.valueNature || 'ACTUAL', drilldown_enabled: w.drilldownEnabled === true, config: w.config || {},
});

/** Texto estável: o jsonb do banco reordena as chaves do objeto, então a comparação ordena as chaves de qualquer profundidade. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

const canonical = (rows) => stable(rows.map((r) => COLUMNS.map((c) => (c === 'config' ? r[c] || {} : r[c]))));

async function currentOf(q, code) {
  const [rows] = await q(`SELECT * FROM analytics.dashboard_definitions WHERE dashboard_code = :code AND ${ZERO_SCOPE} AND status = 'PUBLISHED'`, { code });
  return rows[0] || null;
}

async function widgetsOf(q, dashboardId) {
  const [rows] = await q('SELECT * FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { id: dashboardId });
  return rows;
}

async function inWriterTx(queryInterface, fn) {
  const sequelize = queryInterface.sequelize;
  return sequelize.transaction(async (transaction) => {
    const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
    await q("SELECT set_config('app.analytics_writer', 'on', true)");
    return fn(q);
  });
}

async function publishPanelVersion(queryInterface, { code, widgets, description }) {
  const wanted = widgets.map(fromDefinition);
  return inWriterTx(queryInterface, async (q) => {
    const current = await currentOf(q, code);
    if (!current) throw new Error(`O painel ${code} não está no catálogo (aplique antes a migration 20260101009687).`);
    if (canonical(await widgetsOf(q, current.id)) === canonical(wanted)) return current.version;
    await q("UPDATE analytics.dashboard_definitions SET status = 'RETIRED', updated_at = now() WHERE id = :id", { id: current.id });
    const [[created]] = await q(
      `INSERT INTO analytics.dashboard_definitions
         (dashboard_code, name, description, domain, audience_roles, layout, status, version, p95_target_ms, required_permission)
       VALUES (:code, :name, :description, :domain, CAST(:audience AS jsonb), CAST(:layout AS jsonb), 'DRAFT', :version, :p95, :permission) RETURNING id, version`,
      {
        code, name: current.name, description: description || current.description, domain: current.domain, audience: JSON.stringify(current.audience_roles),
        layout: JSON.stringify(current.layout), version: current.version + 1, p95: current.p95_target_ms, permission: current.required_permission,
      }
    );
    for (const w of wanted) {
      await q(
        `INSERT INTO analytics.dashboard_widgets (dashboard_id, position, widget_type, metric_code, dimension_key, title, value_nature, drilldown_enabled, config)
         VALUES (:id, :position, :widget_type, :metric_code, :dimension_key, :title, :value_nature, :drilldown_enabled, CAST(:config AS jsonb))`,
        { ...w, id: created.id, config: JSON.stringify(w.config) }
      );
    }
    await q("UPDATE analytics.dashboard_definitions SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE id = :id", { id: created.id });
    return created.version;
  });
}

/** Desfaz `publishPanelVersion`: remove a versão vigente (se for a deste conteúdo) e republica a anterior. */
async function unpublishPanelVersion(queryInterface, { code, widgets }) {
  const wanted = widgets.map(fromDefinition);
  return inWriterTx(queryInterface, async (q) => {
    const current = await currentOf(q, code);
    if (!current || current.version < 2 || canonical(await widgetsOf(q, current.id)) !== canonical(wanted)) return;
    await q('ALTER TABLE analytics.dashboard_widgets DISABLE TRIGGER dashboard_widgets_guard');
    await q('ALTER TABLE analytics.dashboard_definitions DISABLE TRIGGER dashboard_definitions_guard');
    try {
      await q('DELETE FROM analytics.dashboard_widgets WHERE dashboard_id = :id', { id: current.id });
      await q('DELETE FROM analytics.dashboard_definitions WHERE id = :id', { id: current.id });
      await q(
        `UPDATE analytics.dashboard_definitions SET status = 'PUBLISHED', updated_at = now()
          WHERE dashboard_code = :code AND ${ZERO_SCOPE} AND version = :version`, { code, version: current.version - 1 }
      );
    } finally {
      await q('ALTER TABLE analytics.dashboard_widgets ENABLE TRIGGER dashboard_widgets_guard');
      await q('ALTER TABLE analytics.dashboard_definitions ENABLE TRIGGER dashboard_definitions_guard');
    }
  });
}

module.exports = { publishPanelVersion, unpublishPanelVersion };
