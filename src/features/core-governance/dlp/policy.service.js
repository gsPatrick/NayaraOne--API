'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const settings = require('./dlp.settings');
const repository = require('./policy.repository');
const { defaultMatrix } = require('./policy.matrix');
const { parseKey, parsePatch, FIELDS } = require('./policy.input');
const { assertFloor } = require('./policy.rules');
const { CLASSES, ACTIONS } = require('./dlp.constants');

const ENTITY = 'governance.dlp_policy';
const AUDIT_ACTION = 'governance.dlp_policy.changed';

const view = (row) => ({
  classification: row.classification, action: row.action, allowed: row.allowed, requirePermission: row.requirePermission, requireJustification: row.requireJustification,
  requireMfa: row.requireMfa, requireAudit: row.requireAudit, requireWatermark: row.requireWatermark, requireMask: row.requireMask, maxRows: row.maxRows,
  maxExpiryHours: row.maxExpiryHours, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
});
const editable = (row) => Object.fromEntries(FIELDS.map((field) => [field, row[field]]));
const same = (a, b) => FIELDS.every((field) => a[field] === b[field]);

async function startingParams(tenant, transaction) {
  const read = (key) => getSetting(key, tenant, transaction, settings.DLP_SETTING_DEFAULTS[key]);
  return {
    volume: settings.parseVolume(await read(settings.VOLUME_KEY)),
    expiry: settings.parseExpiry(await read(settings.EXPIRY_KEY)),
    watermark: settings.parseWatermark(await read(settings.WATERMARK_KEY)),
  };
}

/** Garante as 24 linhas da empresa (matriz padrão + parâmetros governanca.dlp.*) e devolve todas, na ordem classe x ação. */
async function ensureSeeded(tenant, transaction, actorUserId = null) {
  let rows = await repository.list(tenant.companyId, transaction);
  if (rows.length < CLASSES.length * ACTIONS.length) {
    await repository.insertMissing(tenant, defaultMatrix(await startingParams(tenant, transaction)), actorUserId, transaction);
    rows = await repository.list(tenant.companyId, transaction);
  }
  return rows;
}

async function listPolicies(tenant, transaction, { actorUserId = null } = {}) {
  return (await ensureSeeded(tenant, transaction, actorUserId)).map(view);
}

async function getPolicy(tenant, classification, action, transaction) {
  const key = parseKey(classification, action);
  const rows = await ensureSeeded(tenant, transaction);
  return view(rows.find((row) => row.classification === key.classification && row.action === key.action));
}

/**
 * PUT /dlp/policies/:classification/:action (M9-D820 §3.3): trava a linha, aplica só os campos informados, confere o piso do livro e grava a auditoria
 * `governance.dlp_policy.changed` com antes e depois na mesma transação. Conteúdo igual ao atual não grava nem audita (idempotente).
 */
async function updatePolicy(tenant, actor, classification, action, body, transaction) {
  const key = parseKey(classification, action);
  const patch = parsePatch(body);
  await ensureSeeded(tenant, transaction, actor.userId);
  const current = await repository.find(tenant.companyId, key.classification, key.action, transaction, { lock: true });
  const next = { ...editable(current), ...patch };
  assertFloor({ ...key, ...next });
  if (same(editable(current), next)) return view(current);
  await repository.update(tenant.companyId, key.classification, key.action, next, actor.userId, transaction);
  const after = view({ ...current, ...next, updatedBy: actor.userId, updatedAt: new Date() });
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: AUDIT_ACTION, entityType: ENTITY, entityId: null,
    beforeJson: { ...key, ...editable(current) }, afterJson: { ...key, ...next }, reason: `Política de DLP ${key.classification}/${key.action} alterada.`,
  }, transaction);
  return after;
}

module.exports = { listPolicies, getPolicy, updatePolicy, ensureSeeded, view };
