'use strict';

/**
 * M9-D604 (3.1 e 3.3) — edição da definição de métrica: só `name` e `description` podem mudar sem nova versão (sobe a `revision`
 * da versão vigente, com auditoria antes/depois). Qualquer campo numérico diferente do vigente é 409
 * ANALYTICS_METRIC_REQUIRES_NEW_VERSION: não existe edição de versão publicada (gatilho de banco + este serviço).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const store = require('../../../features/analytics/metricStore.service');
const { assertCanManage } = require('./registry.permission');
const { findVisibleDefinitionForUpdate } = require('./registry.scope');
const { VERSIONED_FIELDS, versionFields, diffFields } = require('./registry.diff');

const TEXT_FIELDS = ['name', 'description'];
const SCOPE_KEYS = ['scopeLevel', 'groupId', 'companyId'];

function assertKnownKeys(patch) {
  const allowed = new Set([...TEXT_FIELDS, ...Object.keys(VERSIONED_FIELDS), ...SCOPE_KEYS, 'validFrom']);
  const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
  if (unknown.length) throw AppError.badRequest(`Campos não editáveis: ${unknown.join(', ')}.`, 'ANALYTICS_METRIC_INVALID', { campos: unknown });
}

async function updateDefinition(code, patch, ctx, transaction) {
  assertCanManage(ctx);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw AppError.badRequest('Informe os campos a alterar.', 'ANALYTICS_METRIC_INVALID');
  assertKnownKeys(patch);
  return sequelize.transaction({ transaction }, async (savepoint) => {
    await store.enableAnalyticsWriter(savepoint);
    const def = await findVisibleDefinitionForUpdate(code, patch, ctx, savepoint);
    if (!def) throw AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');
    const [[current]] = def.current_version_id
      ? await sequelize.query('SELECT * FROM analytics.metric_versions WHERE id = :id', { replacements: { id: def.current_version_id }, transaction: savepoint })
      : [[null]];
    if (current) {
      const now = versionFields(current);
      const asked = Object.fromEntries(Object.keys(VERSIONED_FIELDS).filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
      const changed = Object.keys(diffFields(Object.fromEntries(Object.keys(asked).map((k) => [k, now[k]])), asked));
      if (patch.validFrom !== undefined) changed.push('validFrom');
      if (changed.length) {
        throw AppError.conflict('Alterar a fórmula exige publicar uma nova versão.', 'ANALYTICS_METRIC_REQUIRES_NEW_VERSION', { campos: changed });
      }
    }
    const next = {};
    for (const key of TEXT_FIELDS) if (patch[key] !== undefined && patch[key] !== def[key]) next[key] = patch[key];
    if (next.name !== undefined && (typeof next.name !== 'string' || !next.name.trim())) throw AppError.badRequest('O nome da métrica é obrigatório.', 'ANALYTICS_METRIC_INVALID');
    if (!Object.keys(next).length) return { definition: def, version: current, changed: false };
    const name = next.name !== undefined ? next.name.trim() : def.name;
    const description = next.description !== undefined ? next.description : def.description;
    await sequelize.query(
      'UPDATE analytics.metric_definitions SET name = :name, description = :description, updated_by = :actor, updated_at = now() WHERE id = :id',
      { replacements: { name, description, actor: ctx.actorUserId || null, id: def.id }, transaction: savepoint }
    );
    if (current) await sequelize.query('UPDATE analytics.metric_versions SET revision = revision + 1, updated_at = now() WHERE id = :id', { replacements: { id: current.id }, transaction: savepoint });
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'analytics.metric.update_text',
      entityType: 'analytics.metric_definition', entityId: def.id,
      beforeJson: { metricCode: def.metric_code, name: def.name, description: def.description, revision: current ? current.revision : null },
      afterJson: { metricCode: def.metric_code, name, description, revision: current ? current.revision + 1 : null },
      reason: `Revisão de texto da métrica ${def.metric_code}`,
    }, savepoint);
    return { definition: { ...def, name, description }, version: current ? { ...current, revision: current.revision + 1 } : null, changed: true };
  });
}

module.exports = { updateDefinition };
