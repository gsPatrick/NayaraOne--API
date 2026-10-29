'use strict';

/**
 * M9-D604 — nova versão de métrica (BI-008: "Métrica alterada cria nova versão, não reescreve histórico sem trilha").
 * Sem rota HTTP (o livro não lista cadastro de métrica): chamada por migration de dados / worker com
 * `ctx = { groupId, companyId, actorUserId, permissions }`.
 *
 * `publishVersion(code, input, ctx, transaction, options)` roda num SAVEPOINT: trava a definição, confere a versão vigente
 * (`input.version` = a seguinte; senão 409 ANALYTICS_METRIC_VERSION_CONFLICT), valida o resultado como a v1, fecha a vigência da
 * anterior, insere a nova, move o ponteiro, audita a diferença campo a campo e emite `analytics.metric.version_published`.
 * Falha em qualquer passo desfaz tudo. `input` herda da versão vigente os campos que não vierem.
 * options: { catalog, now, reasonMinChars, publishEvent } (injeção para teste).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('./clock');
const store = require('../metricStore.service');
const { assertCanManage } = require('./registry.permission');
const { assertComplete, validateShape } = require('./registry.fields');
const { getFormulaCatalog } = require('./formulaCatalog');
const { findVisibleDefinitionForUpdate } = require('./registry.scope');
const { assertReadModelExists, checkFormula } = require('./registry.checks');
const { VERSIONED_FIELDS, versionFields, diffFields } = require('./registry.diff');
const { readReasonMinChars } = require('./metrics.settings');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPE = 'analytics.metric.version_published';

function assertReason(input, min) {
  const reason = typeof input.changeReason === 'string' ? input.changeReason.trim() : '';
  if (reason.length < min) {
    throw AppError.badRequest(`Informe o motivo da mudança (mínimo de ${min} caracteres).`, 'ANALYTICS_CHANGE_REASON_REQUIRED', { minimo: min });
  }
  return reason;
}

function assertValidFrom(validFrom, today) {
  if (typeof validFrom !== 'string' || !DATE_RE.test(validFrom) || Number.isNaN(Date.parse(`${validFrom}T00:00:00Z`))) {
    throw AppError.badRequest('O início da vigência deve ser uma data AAAA-MM-DD.', 'ANALYTICS_METRIC_INVALID');
  }
  if (validFrom < today) {
    throw AppError.unprocessable('A nova versão não pode começar no passado.', 'ANALYTICS_VALID_FROM_PAST', { hoje: today });
  }
}

async function loadCurrent(def, transaction) {
  if (def.status === 'RETIRED') {
    throw AppError.conflict('Indicador aposentado não recebe nova versão. Crie uma nova métrica com outro código.', 'ANALYTICS_METRIC_RETIRED');
  }
  const [rows] = def.current_version_id
    ? await sequelize.query('SELECT * FROM analytics.metric_versions WHERE id = :id', { replacements: { id: def.current_version_id }, transaction })
    : [[]];
  if (!rows[0]) throw AppError.conflict('A métrica ainda não tem versão publicada.', 'ANALYTICS_METRIC_STATE_INVALID', { status: def.status });
  return rows[0];
}

function mergeNext(input, def, previous, fields) {
  const next = { ...fields };
  for (const key of Object.keys(VERSIONED_FIELDS)) if (input[key] !== undefined) next[key] = input[key];
  return {
    ...next, metricCode: def.metric_code, name: def.name, description: def.description || def.name, ownerRole: def.owner_role || 'n/d',
    criticality: def.criticality, version: previous.version + 1, validFrom: input.validFrom, changeReason: input.changeReason,
  };
}

async function publishInside(code, input, ctx, savepoint, options) {
  await store.enableAnalyticsWriter(savepoint);
  const def = await findVisibleDefinitionForUpdate(code, input, ctx, savepoint);
  if (!def) throw AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');
  const previous = await loadCurrent(def, savepoint);
  if (previous.version !== input.version - 1) {
    throw AppError.conflict(
      'Esta métrica foi publicada por outra pessoa enquanto você editava. Recarregue e publique de novo.',
      'ANALYTICS_METRIC_VERSION_CONFLICT', { versaoVigente: previous.version }
    );
  }
  const before = versionFields(previous);
  const merged = mergeNext(input, def, previous, before);
  assertComplete(merged);
  validateShape(merged);
  const after = Object.fromEntries(Object.keys(VERSIONED_FIELDS).map((k) => [k, merged[k]]));
  const changes = diffFields(before, after);
  if (!Object.keys(changes).length) {
    throw AppError.unprocessable('Nada mudou na definição do indicador; não há o que versionar.', 'ANALYTICS_VERSION_NO_CHANGES');
  }
  await assertReadModelExists(merged.sourceReadModel, savepoint);
  const formulaTestHash = checkFormula(merged, options.catalog || getFormulaCatalog());
  const version = await store.publishMetricVersion({
    definitionId: def.id, ...after,
    formulaTestHash, formulaCodeHash: (options.catalog || getFormulaCatalog()).codeHash(merged.formulaId), validFrom: input.validFrom, expectedVersion: previous.version, changeReason: input.changeReason.trim(),
  }, ctx, savepoint);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'analytics.metric.version_published',
    entityType: 'analytics.metric_version', entityId: version.id,
    beforeJson: { metricCode: def.metric_code, versao: previous.version, validUntil: input.validFrom },
    afterJson: { metricCode: def.metric_code, versao: version.version, validFrom: input.validFrom, changes },
    reason: input.changeReason.trim(),
  }, savepoint);
  const publish = options.publishEvent || publishDomainEvent;
  await publish({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'analytics.metric', aggregateId: def.id, eventType: EVENT_TYPE,
    payload: { metricCode: def.metric_code, version: version.version, previousVersion: previous.version, validFrom: input.validFrom, changedFields: Object.keys(changes) },
    idempotencyKey: `${EVENT_TYPE}:${version.id}`,
  }, savepoint);
  return { definition: { ...def, current_version_id: version.id }, version, previous, changes };
}

async function publishVersion(code, input, ctx, transaction, options = {}) {
  assertCanManage(ctx);
  if (!input || !Number.isInteger(input.version) || input.version < 2) {
    throw AppError.badRequest('Informe a versão que será publicada (a seguinte à vigente).', 'ANALYTICS_METRIC_INVALID');
  }
  assertReason(input, options.reasonMinChars || await readReasonMinChars(ctx, transaction));
  assertValidFrom(input.validFrom, businessDateKey(options.now || clock.now()));
  return sequelize.transaction({ transaction }, (savepoint) => publishInside(code, input, ctx, savepoint, options));
}

module.exports = { publishVersion, EVENT_TYPE };
