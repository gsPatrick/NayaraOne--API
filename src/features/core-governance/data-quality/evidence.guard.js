'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { hashPiiValue } = require('../../people/personDocumentFormat.service');
const settings = require('./evidence.settings');
const errors = require('./evidence.errors');
const repository = require('./evidence.repository');
const { SOURCES, SYSTEM_IMPORT, FILE_REQUIRED_SOURCES, NOTE_REQUIRED_SOURCES } = require('./evidence.constants');
const { criticalFieldsFor, changedCriticalFields } = require('./evidence.criticalFields');
const { createImportContext, isImportContext } = require('./evidence.importContext');

/** Lê changeEvidence do corpo (camelCase ou snake_case) para o formato interno. */
function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = typeof raw.source === 'string' ? raw.source.trim().toUpperCase() : '';
  const fileId = raw.evidenceFileId !== undefined ? raw.evidenceFileId : raw.evidence_file_id;
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  return { source, evidenceFileId: fileId || null, note: note || null };
}

/**
 * assertEvidenceForCriticalChange (M9-D807 §3.3). `entity` = { type, id, groupId, companyId, current, families? }: o registro hoje, para saber o
 * que muda de fato. `patch` = os campos que o chamador vai gravar. `evidence` = changeEvidence do corpo. `ctx` = { transaction, actorUserId,
 * importContext? }. Sem campo crítico alterado devolve { changes: [], evidence: null } e nada é exigido; com campo crítico sem evidência
 * válida lança 422 e o chamador não grava nada. Devolve { changes, evidence } para recordFieldChangeEvidence usar depois da gravação.
 */
async function assertEvidenceForCriticalChange(entity, patch, evidence, ctx = {}) {
  const tenant = { groupId: entity.groupId, companyId: entity.companyId };
  const changes = changedCriticalFields(entity, patch, await criticalFieldsFor(tenant, ctx.transaction));
  if (!changes.length) return { changes: [], evidence: null };
  const given = normalizeEvidence(evidence);
  if (!given) throw errors.required();
  if (!SOURCES.includes(given.source)) throw errors.sourceInvalid();
  if (given.source === SYSTEM_IMPORT && !isImportContext(ctx.importContext)) throw errors.sourceInvalid();
  if (FILE_REQUIRED_SOURCES.includes(given.source) && !given.evidenceFileId) throw errors.fileRequired();
  if (NOTE_REQUIRED_SOURCES.includes(given.source)) {
    const minimum = Number(await getSetting(settings.NOTE_MIN_KEY, tenant, ctx.transaction, settings.DEFAULT_NOTE_MIN)) || settings.DEFAULT_NOTE_MIN;
    if ((given.note || '').length < minimum) throw errors.noteTooShort(minimum);
  }
  if (given.evidenceFileId && !(await repository.companyFileExists(entity.companyId, given.evidenceFileId, ctx.transaction))) throw errors.fileNotFound();
  return { changes, evidence: given };
}

const hashOf = (field, value) => (value === null ? null : hashPiiValue(`${field}\u0000${value}`));

/**
 * Grava, na mesma transação do cadastro, uma linha de governance.field_change_evidence por campo crítico alterado (só hash do valor) e a
 * entrada de auditoria com o antes e depois legíveis, ligada por audit_log_id. Sem mudança crítica não grava nada.
 */
async function recordFieldChangeEvidence(entity, assertion, ctx = {}) {
  if (!assertion || !assertion.changes.length) return null;
  const { changes, evidence } = assertion;
  const audit = await registrarAuditoria({
    groupId: entity.groupId, companyId: entity.companyId, actorUserId: ctx.actorUserId, action: 'governance.field_change_evidence.recorded',
    entityType: entity.type, entityId: entity.id,
    beforeJson: Object.fromEntries(changes.map((c) => [c.field, c.before])), afterJson: Object.fromEntries(changes.map((c) => [c.field, c.after])),
    reason: `Alteração de campo crítico com origem ${evidence.source}${evidence.evidenceFileId ? ' e comprovante anexado' : ''}.`,
  }, ctx.transaction);
  for (const change of changes) {
    await repository.insertEvidence({
      groupId: entity.groupId, companyId: entity.companyId, entityType: entity.type, entityId: entity.id, field: change.field,
      beforeHash: hashOf(change.field, change.before), afterHash: hashOf(change.field, change.after), source: evidence.source,
      fileId: evidence.evidenceFileId, note: evidence.note, actorUserId: ctx.actorUserId || null, auditLogId: audit.id,
    }, ctx.transaction);
  }
  return audit.id;
}

module.exports = {
  assertEvidenceForCriticalChange, recordFieldChangeEvidence, createImportContext, criticalFieldsFor,
  DEFAULT_CRITICAL_FIELDS: settings.DEFAULT_CRITICAL_FIELDS,
};
