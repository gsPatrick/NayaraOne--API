'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repository = require('./retention.policy.repository');
const { parsePolicyBody, assertTargetsFit } = require('./retention.input');
const { seedPolicies, integrationMonths } = require('./retention.seeds');
const targets = require('./retention.targets');
const errors = require('./retention.errors');

const AUDIT_ACTION = 'governance.retention.policy.changed';
const ENTITY_TYPE = 'RetentionPolicy';

/** Semeia as políticas da empresa na primeira vez (idempotente). */
async function ensurePolicies(tenant, transaction) {
  const existing = await repository.list(tenant, transaction);
  if (existing.length > 0) return existing;
  for (const policy of await seedPolicies(tenant, transaction)) await repository.insertSeed(tenant, policy, transaction);
  return repository.list(tenant, transaction);
}

async function listPolicies(tenant, transaction) {
  return ensurePolicies(tenant, transaction);
}

const sameContent = (a, b) => JSON.stringify([a.name, a.retentionMonths, a.trigger, a.legalBasis, a.disposition, a.exceptions, a.dataTypes, a.ownerDomain, a.autoApply])
  === JSON.stringify([b.name, b.retentionMonths, b.trigger, b.legalBasis, b.disposition, b.exceptions, b.dataTypes, b.ownerDomain, b.autoApply]);

/** O mesmo tipo de dado não pode estar em duas políticas (a regra de qual vale seria ambígua). */
function assertTargetsFree(policy, all) {
  for (const code of policy.dataTypes) {
    const owner = all.find((other) => other.code !== policy.code && other.dataTypes.includes(code));
    if (owner) throw errors.targetTaken({ target: code, policy: owner.code });
  }
}

/** PUT /retention/policies: cria ou altera a política `code`; PUT igual não muda nada (nem a versão); a alteração é auditada com antes e depois. */
async function putPolicy(tenant, actor, body, transaction) {
  const all = await ensurePolicies(tenant, transaction);
  const existing = all.find((policy) => policy.code === String(body && body.code).trim().toUpperCase()) || null;
  const parsed = parsePolicyBody(body, existing);
  assertTargetsFit(parsed);
  assertTargetsFree(parsed, all);
  // Calendário que vem dos parâmetros de integração: o prazo mostrado é derivado deles (informativo), não digitado.
  if (parsed.dataTypes.some((code) => targets.get(code).scheduleFromParams)) parsed.retentionMonths = await integrationMonths(tenant, transaction);
  if (existing && sameContent(existing, { ...parsed, legalBasis: { code: parsed.legalBasis.code, text: parsed.legalBasis.text, referenceText: parsed.legalBasis.referenceText } })) return { policy: existing, changed: false };
  const saved = existing ? await repository.update(tenant, parsed, actor.userId, transaction) : await repository.insert(tenant, parsed, actor.userId, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: AUDIT_ACTION, entityType: ENTITY_TYPE, entityId: saved.id,
    beforeJson: existing, afterJson: saved, reason: `Política de retenção ${saved.code} ${existing ? `alterada (versão ${saved.version})` : 'criada'}.`,
  }, transaction);
  return { policy: saved, changed: true };
}

module.exports = { ensurePolicies, listPolicies, putPolicy, AUDIT_ACTION };
