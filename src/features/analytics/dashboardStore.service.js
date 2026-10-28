'use strict';

/**
 * M9-D601 — painéis do BI: analytics.dashboard_definitions e analytics.dashboard_widgets.
 *
 * Regras do livro: cada painel publicado é versionado como a métrica (mudar widgets cria version+1,
 * numa linha nova em DRAFT que parte dos widgets da anterior); o widget aponta para um metric_code
 * PUBLICADO (validado na publicação) e nunca carrega fórmula ou SQL. Painel fora de DRAFT é imutável
 * (gatilho do banco). Escrita só com app.analytics_writer = 'on' (worker/migration ou a rota
 * administrativa depois de checar `analytics:manage`). O catálogo dos 12 painéis é da M9-D687.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { DOMAINS } = require('./metricStore.service');
const { assertPublishable, loadWidgets, widgetDiff } = require('./dashboardPublishRules');
const { normalizeWidget } = require('./dashboardWidgetRules');
const { run, invalid, requireOneOf, requireText, resolveScope, assertWriter } = require('./analyticsStoreSupport');

const CODE = 'ANALYTICS_DASHBOARD_INVALID';
// Painéis gerais (Saúde Geral e Centro de Comando) não pertencem a um domínio de métrica.
const DASHBOARD_DOMAINS = [...DOMAINS, 'GENERAL'];
const DASHBOARD_CODE_RE = /^[a-z][a-z0-9_]*$/;
const SAME_SCOPE = `company_id IS NOT DISTINCT FROM :companyId AND group_id IS NOT DISTINCT FROM :groupId`;
const notFound = () => AppError.notFound('Painel não encontrado.', 'ANALYTICS_DASHBOARD_NOT_FOUND');

async function loadDashboard(id, transaction, { lock = false } = {}) {
  const [rows] = await sequelize.query(`SELECT * FROM analytics.dashboard_definitions WHERE id = :id${lock ? ' FOR UPDATE' : ''}`, {
    replacements: { id }, transaction,
  });
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function resolveBase(input, transaction) {
  if (!input.baseDashboardId) return { input, base: null };
  const base = await loadDashboard(input.baseDashboardId, transaction);
  const scopeLevel = base.company_id ? 'COMPANY' : base.group_id ? 'GROUP' : 'GLOBAL';
  return {
    base,
    input: {
      scopeLevel, groupId: base.group_id, companyId: base.company_id, dashboardCode: base.dashboard_code, name: base.name,
      description: base.description, domain: base.domain, audienceRoles: base.audience_roles, layout: base.layout,
      requiredPermission: base.required_permission, p95TargetMs: base.p95_target_ms, ...input,
    },
  };
}

function validateDefinition(input) {
  if (typeof input.dashboardCode !== 'string' || !DASHBOARD_CODE_RE.test(input.dashboardCode)) {
    throw invalid(CODE, 'O código do painel deve ser minúsculo, com números e "_".');
  }
  requireText(input.name, 'O nome do painel', CODE);
  requireOneOf(input.domain, DASHBOARD_DOMAINS, 'Domínio', CODE);
  requireText(input.requiredPermission, 'A permissão de leitura do painel', CODE);
  if (input.audienceRoles !== undefined && !Array.isArray(input.audienceRoles)) throw invalid(CODE, 'Os papéis do painel devem ser uma lista.');
  if (input.p95TargetMs != null && (!Number.isInteger(input.p95TargetMs) || input.p95TargetMs <= 0)) throw invalid(CODE, 'A meta p95 deve ser um inteiro positivo (ms).');
}

/** Cria o painel em DRAFT (version 1) ou, com baseDashboardId, a próxima versão copiando os widgets da base. */
async function createDashboardDefinition(rawInput, ctx, transaction) {
  await assertWriter(transaction);
  return run(async () => {
    const { input, base } = await resolveBase(rawInput, transaction);
    validateDefinition(input);
    const scope = resolveScope(input, CODE);
    const [[next]] = await sequelize.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS n FROM analytics.dashboard_definitions WHERE dashboard_code = :code AND ${SAME_SCOPE}`,
      { replacements: { code: input.dashboardCode, ...scope }, transaction }
    );
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.dashboard_definitions
         (company_id, group_id, dashboard_code, name, description, domain, audience_roles, layout, status, version, p95_target_ms,
          required_permission, created_by, updated_by)
       VALUES (:companyId, :groupId, :code, :name, :description, :domain, CAST(:audience AS jsonb), CAST(:layout AS jsonb), 'DRAFT',
          :version, :p95, :permission, :actor, :actor)
       RETURNING *`,
      {
        replacements: {
          ...scope, code: input.dashboardCode, name: input.name.trim(), description: input.description || null, domain: input.domain,
          audience: JSON.stringify(input.audienceRoles || []), layout: JSON.stringify(input.layout || {}), version: Number(next.n),
          p95: input.p95TargetMs ?? null, permission: input.requiredPermission, actor: ctx?.actorUserId || null,
        },
        transaction,
      }
    );
    if (base) {
      await sequelize.query(
        `INSERT INTO analytics.dashboard_widgets
           (company_id, group_id, dashboard_id, position, widget_type, metric_code, dimension_key, title, value_nature, drilldown_enabled, config)
         SELECT company_id, group_id, :newId, position, widget_type, metric_code, dimension_key, title, value_nature, drilldown_enabled, config
           FROM analytics.dashboard_widgets WHERE dashboard_id = :baseId`,
        { replacements: { newId: row.id, baseId: base.id }, transaction }
      );
    }
    return row;
  });
}

async function addDashboardWidget(dashboardId, rawWidget, ctx, transaction) {
  await assertWriter(transaction);
  const widget = normalizeWidget(rawWidget);
  return run(async () => {
    const dash = await loadDashboard(dashboardId, transaction);
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.dashboard_widgets
         (company_id, group_id, dashboard_id, position, widget_type, metric_code, dimension_key, title, value_nature, drilldown_enabled, config)
       VALUES (:companyId, :groupId, :dashboardId, :position, :widgetType, :metricCode, :dimensionKey, :title, :valueNature, :drilldownEnabled, CAST(:config AS jsonb))
       RETURNING *`,
      { replacements: { ...widget, config: JSON.stringify(widget.config), companyId: dash.company_id, groupId: dash.group_id, dashboardId }, transaction }
    );
    return row;
  });
}

/** Códigos de métrica dos widgets que NÃO estão publicados num escopo visível ao painel. */
async function findUnpublishedMetrics(dash, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT w.metric_code FROM analytics.dashboard_widgets w
      WHERE w.dashboard_id = :id AND w.metric_code IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM analytics.metric_definitions m
           WHERE m.metric_code = w.metric_code AND m.status = 'PUBLISHED'
             AND ((m.company_id IS NULL AND m.group_id IS NULL)
               OR (m.company_id IS NOT NULL AND m.company_id = :companyId)
               OR (m.company_id IS NULL AND m.group_id IS NOT NULL AND m.group_id = :groupId)))
      ORDER BY 1`,
    { replacements: { id: dash.id, companyId: dash.company_id, groupId: dash.group_id }, transaction }
  );
  return rows.map((r) => r.metric_code);
}

/** Publica o painel DRAFT: trava a linha, valida as métricas, aposenta a versão anterior e audita. */
async function publishDashboard(dashboardId, ctx, transaction) {
  await assertWriter(transaction);
  return run(async () => {
    const dash = await loadDashboard(dashboardId, transaction, { lock: true });
    if (dash.status !== 'DRAFT') {
      throw AppError.conflict('Só um painel em rascunho pode ser publicado.', 'ANALYTICS_DASHBOARD_NOT_DRAFT', { status: dash.status });
    }
    const missing = await findUnpublishedMetrics(dash, transaction);
    if (missing.length) {
      throw AppError.unprocessable('O painel referencia um indicador que não está publicado.', 'ANALYTICS_DASHBOARD_INVALID_METRIC', { metricCodes: missing });
    }
    const widgets = await assertPublishable(dash, transaction);
    const [retired] = await sequelize.query(
      `UPDATE analytics.dashboard_definitions SET status = 'RETIRED', updated_at = now(), updated_by = :actor
        WHERE dashboard_code = :code AND ${SAME_SCOPE} AND status = 'PUBLISHED' AND id <> :id RETURNING id, version`,
      { replacements: { code: dash.dashboard_code, companyId: dash.company_id, groupId: dash.group_id, id: dash.id, actor: ctx?.actorUserId || null }, transaction }
    );
    const [[published]] = await sequelize.query(
      `UPDATE analytics.dashboard_definitions SET status = 'PUBLISHED', published_at = now(), updated_at = now(), updated_by = :actor
        WHERE id = :id RETURNING *`,
      { replacements: { id: dash.id, actor: ctx?.actorUserId || null }, transaction }
    );
    const previousWidgets = retired[0] ? await loadWidgets(retired[0].id, transaction) : [];
    await registrarAuditoria(
      {
        groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'analytics.dashboard.publish',
        entityType: 'analytics.dashboard', entityId: dash.id,
        beforeJson: { dashboardCode: dash.dashboard_code, status: dash.status, versaoAposentada: retired[0]?.version ?? null },
        afterJson: { dashboardCode: dash.dashboard_code, status: 'PUBLISHED', versao: dash.version, diferencaWidgets: widgetDiff(previousWidgets, widgets) },
        reason: `Publicação do painel ${dash.dashboard_code} (versão ${dash.version})`,
      },
      transaction
    );
    return published;
  });
}

async function getDashboardWithWidgets(dashboardId, transaction) {
  const dash = await loadDashboard(dashboardId, transaction);
  const [widgets] = await sequelize.query('SELECT * FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position ASC', {
    replacements: { id: dashboardId }, transaction,
  });
  return { ...dash, widgets };
}

module.exports = { createDashboardDefinition, addDashboardWidget, publishDashboard, getDashboardWithWidgets };
