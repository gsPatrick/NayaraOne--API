'use strict';

const { InsurancePolicyVersion, InsuranceRenewalTask, File, FileLink, sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishRenewalUpserted } = require('../insuranceCalendarEvents.service');
const E = require('./insurance.errors');
const { publishVersionAdded } = require('./insurance.events');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['INITIAL', 'ENDORSEMENT', 'RENEWAL'];
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** O documento da versão: precisa existir na empresa e ter o hash SHA-256 gravado. Sem um dos dois a versão não vira vigente (422 INTEGRATION_INSURANCE_POLICY_DOCUMENT_REQUIRED). */
async function loadDocument(policy, fileId, transaction) {
  if (!fileId) throw E.documentRequired();
  const file = await File.findOne({ where: { id: fileId, companyId: policy.companyId }, transaction });
  if (!file || !/^[0-9a-f]{64}$/i.test(String(file.checksumSha256 || ''))) throw E.documentRequired();
  return file;
}

async function nextVersionNumber(policyId, transaction) {
  const max = await InsurancePolicyVersion.max('version', { where: { policyId }, transaction });
  return (Number.isInteger(max) ? max : 0) + 1;
}

/** Renovação: a vigência da apólice passa a ser a da versão nova e o ciclo de alertas recomeça (nova tarefa de renovação e marcos da nova vigência). */
async function applyRenewal(policy, { effectiveFrom, expiryDate }, actor, transaction) {
  const antes = policy.toJSON();
  policy.effectiveDate = effectiveFrom;
  policy.expiryDate = expiryDate;
  if (policy.status === 'EXPIRED' && expiryDate >= new Date().toISOString().slice(0, 10)) policy.status = 'ACTIVE';
  policy.updatedBy = actor.userId || null;
  await policy.save({ transaction });
  const task = await InsuranceRenewalTask.create({ groupId: policy.groupId, companyId: policy.companyId, policyId: policy.id, dueDate: addDays(expiryDate, -30), status: 'PENDING' }, { transaction });
  await publishRenewalUpserted(task, policy, transaction);
  await registrarAuditoria({
    groupId: policy.groupId, companyId: policy.companyId, actorUserId: actor.userId || null, action: 'procurement.insurance_policy.renew', entityType: 'InsurancePolicy', entityId: policy.id,
    beforeJson: antes, afterJson: policy.toJSON(), reason: `Renovação registrada: nova vigência até ${expiryDate}.`,
  }, transaction);
}

/**
 * addPolicyVersion — registra uma versão do documento da apólice (M9-D238 3.3): inicial, endosso ou renovação. A versão é imutável (gatilho no banco), a anterior é preservada e a
 * versão só vale com documento e hash. Número repetido: 409 INTEGRATION_INSURANCE_POLICY_VERSION_EXISTS. Renovação traz o fim da nova vigência, posterior ao atual.
 * `args`: fileId, kind (padrão ENDORSEMENT; a primeira versão é INITIAL), effectiveFrom, expiryDate, version (opcional), receivedAt, source (API ou MANUAL).
 */
async function addPolicyVersion(policy, args, actor, transaction) {
  const a = args || {};
  const file = await loadDocument(policy, a.fileId, transaction);
  const proxima = await nextVersionNumber(policy.id, transaction);
  const numero = a.version === undefined || a.version === null ? proxima : Number(a.version);
  if (!Number.isInteger(numero) || numero < 1) throw E.versionInvalid('O número da versão deve ser um inteiro a partir de 1.');
  if (numero < proxima) throw E.versionExists(numero);
  if (numero > proxima) throw E.versionInvalid(`A próxima versão da apólice é a ${proxima}.`);
  const kind = numero === 1 ? 'INITIAL' : (a.kind || 'ENDORSEMENT');
  if (!KINDS.includes(kind) || (kind === 'INITIAL' && numero !== 1) || (numero > 1 && kind === 'INITIAL')) throw E.versionInvalid('O tipo da versão deve ser ENDORSEMENT ou RENEWAL (a primeira versão é a inicial).');
  const effectiveFrom = a.effectiveFrom || policy.effectiveDate;
  if (!isDate(effectiveFrom)) throw E.versionInvalid('Informe o início da vigência da versão (AAAA-MM-DD).');
  let expiryDate = a.expiryDate || null;
  if (expiryDate !== null && !isDate(expiryDate)) throw E.versionInvalid('O fim da vigência deve ser uma data (AAAA-MM-DD).');
  if (kind === 'RENEWAL') {
    if (!expiryDate || expiryDate <= effectiveFrom) throw E.versionInvalid('A renovação precisa informar o fim da nova vigência, posterior ao início.');
    if (policy.expiryDate && expiryDate <= String(policy.expiryDate).slice(0, 10)) throw E.versionInvalid('O fim da nova vigência deve ser posterior ao fim da vigência atual.');
  } else if (kind === 'INITIAL') {
    expiryDate = expiryDate || (policy.expiryDate ? String(policy.expiryDate).slice(0, 10) : null);
  }
  let version;
  try {
    version = await sequelize.transaction({ transaction }, (savepoint) => InsurancePolicyVersion.create({
      groupId: policy.groupId, companyId: policy.companyId, policyId: policy.id, version: numero, kind, fileId: file.id, sha256: String(file.checksumSha256).toLowerCase(), effectiveFrom, expiryDate,
      receivedAt: a.receivedAt ? new Date(a.receivedAt) : new Date(), source: a.source === 'MANUAL' ? 'MANUAL' : 'API', createdBy: actor.userId || null,
    }, { transaction: savepoint }));
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') throw E.versionExists(numero);
    throw err;
  }
  await FileLink.findOrCreate({
    where: { relatedEntityType: 'InsurancePolicy', relatedEntityId: policy.id, fileId: file.id, purpose: 'POLICY_VERSION' },
    defaults: { groupId: policy.groupId, companyId: policy.companyId, fileId: file.id, relatedEntityType: 'InsurancePolicy', relatedEntityId: policy.id, purpose: 'POLICY_VERSION', createdBy: actor.userId || null, updatedBy: actor.userId || null },
    transaction,
  });
  if (kind === 'RENEWAL') await applyRenewal(policy, { effectiveFrom, expiryDate }, actor, transaction);
  await registrarAuditoria({
    groupId: policy.groupId, companyId: policy.companyId, actorUserId: actor.userId || null, action: 'procurement.insurance_policy.version_added', entityType: 'InsurancePolicy', entityId: policy.id,
    afterJson: { version: numero, kind, fileId: file.id, sha256: version.sha256, source: version.source }, reason: `Versão ${numero} da apólice registrada (${kind}).`,
  }, transaction);
  await publishVersionAdded(policy, version, transaction);
  return version;
}

async function listPolicyVersions(policyId, companyId, transaction) {
  return InsurancePolicyVersion.findAll({ where: { policyId, companyId }, order: [['version', 'ASC']], transaction });
}

/** A versão vigente é a de maior número. */
async function currentVersion(policyId, companyId, transaction) {
  return InsurancePolicyVersion.findOne({ where: { policyId, companyId }, order: [['version', 'DESC']], transaction });
}

module.exports = { addPolicyVersion, listPolicyVersions, currentVersion };
