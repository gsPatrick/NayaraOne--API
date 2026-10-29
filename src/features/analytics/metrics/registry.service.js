'use strict';

/**
 * M9-D603 — Metric Registry: publicação e aposentadoria de métricas. Sem rota HTTP (o livro não lista rota de
 * cadastro); é chamado por migration de dados / worker (M9-D712) com `ctx = { groupId, companyId, actorUserId, permissions }`.
 *
 * Publicar (3.2): 15 campos completos -> fórmula no catálogo do código -> read model existente -> testes da fórmula
 * (dry-run, hash gravado em formula_test_hash) -> definição + versão 1 + ponteiro, numa transação, com auditoria.
 * Nova versão de métrica já publicada é da M9-D604; aqui um código já publicado responde 409.
 * Aposentar: PUBLISHED -> RETIRED; recusado se painel publicado usa a métrica. RETIRED não volta (cria-se outra).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const store = require('../metricStore.service');
const { assertCanManage } = require('./registry.permission');
const { assertComplete, validateShape } = require('./registry.fields');
const { getFormulaCatalog } = require('./formulaCatalog');
const { resolveScope, findDefinitionForUpdate } = require('./registry.scope');
const { assertReadModelExists, checkFormula } = require('./registry.checks');
const { assertInCriticalityTable } = require('./seed/criticality.table');

async function prepareDefinition(input, domain, scope, ctx, transaction) {
  const existing = await findDefinitionForUpdate(input.metricCode, scope, transaction);
  if (!existing) {
    return store.createMetricDefinition({
      ...scope, metricCode: input.metricCode, name: input.name, description: input.description, domain,
      criticality: input.criticality, ownerRole: input.ownerRole, drilldownEnabled: input.drilldownEnabled === true,
    }, ctx, transaction);
  }
  if (existing.status === 'RETIRED') {
    throw AppError.conflict('Indicador aposentado não volta a ser publicado. Crie uma nova métrica com outro código.', 'ANALYTICS_METRIC_RETIRED');
  }
  if (existing.status === 'PUBLISHED' || existing.current_version_id) {
    throw AppError.conflict('Já existe indicador com este código.', 'ANALYTICS_METRIC_CODE_DUPLICATE');
  }
  await sequelize.query(
    `UPDATE analytics.metric_definitions SET name = :name, description = :description, domain = :domain, criticality = :criticality,
        drilldown_enabled = (drilldown_enabled OR :criticality = 'CRITICAL'), owner_role = :ownerRole, updated_by = :actor, updated_at = now() WHERE id = :id`,
    { replacements: { name: input.name.trim(), description: input.description, domain, criticality: input.criticality, ownerRole: input.ownerRole, actor: ctx.actorUserId || null, id: existing.id }, transaction }
  );
  return existing;
}

/**
 * Publica a versão 1 de uma métrica (definição + versão + ponteiro). Devolve { definition, version }.
 * `options.catalog` troca o catálogo de fórmulas (testes).
 */
async function publishMetric(input, ctx, transaction, options = {}) {
  assertCanManage(ctx);
  assertComplete(input);
  const domain = validateShape(input);
  if ((input.scopeLevel || 'GLOBAL') === 'GLOBAL') assertInCriticalityTable(input.metricCode); // M9-D712 3.4: métrica global só publica com linha na tabela
  await assertReadModelExists(input.sourceReadModel, transaction);
  const formulaTestHash = checkFormula(input, options.catalog || getFormulaCatalog());

  await store.enableAnalyticsWriter(transaction);
  const scope = resolveScope(input, ctx);
  const definition = await prepareDefinition(input, domain, scope, ctx, transaction);
  const version = await store.publishMetricVersion({
    definitionId: definition.id, formulaId: input.formulaId, formulaSemantic: input.formulaSemantic,
    sourceReadModel: input.sourceReadModel, dimensions: input.dimensions, filters: input.filters, unit: input.unit,
    refreshPolicy: input.refreshPolicy, qualityRule: input.qualityRule, valueNature: input.valueNature,
    formulaTestHash, formulaCodeHash: (options.catalog || getFormulaCatalog()).codeHash(input.formulaId), formulaParams: input.formulaParams, validFrom: input.validFrom, expectedVersion: input.version - 1, changeReason: input.changeReason,
  }, ctx, transaction);
  return { definition: { ...definition, status: 'PUBLISHED', current_version_id: version.id }, version };
}

async function listPublishedPanels(code, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT d.dashboard_code FROM analytics.dashboard_widgets w
       JOIN analytics.dashboard_definitions d ON d.id = w.dashboard_id
      WHERE w.metric_code = :code AND d.status = 'PUBLISHED' ORDER BY d.dashboard_code`,
    { replacements: { code }, transaction }
  );
  return rows.map((r) => r.dashboard_code);
}

/** Aposenta a métrica PUBLISHED. 409 ANALYTICS_METRIC_IN_USE se painel publicado a usa (a lista vai na mensagem). */
async function retireMetric(input, ctx, transaction) {
  assertCanManage(ctx);
  if (!input || typeof input.metricCode !== 'string' || !input.metricCode) throw AppError.badRequest('Informe o código da métrica.', 'ANALYTICS_METRIC_INVALID');
  await store.enableAnalyticsWriter(transaction);
  const scope = resolveScope(input, ctx);
  const def = await findDefinitionForUpdate(input.metricCode, scope, transaction);
  if (!def) throw AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');
  if (def.status !== 'PUBLISHED') {
    throw AppError.conflict('Só uma métrica publicada pode ser aposentada.', 'ANALYTICS_METRIC_STATE_INVALID', { status: def.status });
  }
  const panels = await listPublishedPanels(def.metric_code, transaction);
  if (panels.length) {
    throw AppError.conflict(`Indicador em uso por painéis publicados: ${panels.join(', ')}.`, 'ANALYTICS_METRIC_IN_USE', { paineis: panels });
  }
  await sequelize.query(`UPDATE analytics.metric_definitions SET status = 'RETIRED', updated_by = :actor, updated_at = now() WHERE id = :id`, {
    replacements: { actor: ctx.actorUserId || null, id: def.id }, transaction,
  });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'analytics.metric.retire',
    entityType: 'analytics.metric_definition', entityId: def.id,
    beforeJson: { metricCode: def.metric_code, status: def.status, currentVersionId: def.current_version_id },
    afterJson: { metricCode: def.metric_code, status: 'RETIRED', currentVersionId: def.current_version_id },
    reason: `Aposentadoria da métrica ${def.metric_code}`,
  }, transaction);
  return { ...def, status: 'RETIRED' };
}

module.exports = { publishMetric, retireMetric };
