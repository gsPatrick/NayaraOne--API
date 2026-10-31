'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { AUDIT, AUDIT_ENTITY, REASON_MAX, SECTOR_CODES, flagKey, isSector } = require('./canary.constants');
const errors = require('./canary.errors');
const params = require('./canary.params');
const flag = require('./canary.flag');
const gate = require('./canary.gate');
const members = require('./canary.members');
const { pickTarget } = require('./canary.steps');
const { runRollbackHooks } = require('./canary.hooks');
require('../rollback'); // M9-D907: registra o gancho que cria os rollback_items no rollback de setor

function assertSector(sector) {
  if (!isSector(sector)) throw errors.sectorUnknown(sector);
  return sector;
}

const audit = (tenant, action, entry, before, after, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId || null, action, entityType: AUDIT_ENTITY, entityId: entry.id, beforeJson: before, afterJson: after, reason,
}, transaction);

/** O que a API devolve do setor: percentual, usuários do setor e quantos operam no novo, versão da flag. */
async function view(tenant, sector, entry, stages, transaction) {
  const percent = flag.percentOf(entry);
  const { members: all, selected } = await members.canaryOf(tenant, sector, percent, transaction);
  return {
    sector, percent, flagKey: flagKey(sector), flagId: entry ? entry.id : null, version: entry ? entry.version : null,
    stages, nextStep: stages.find((stage) => stage > percent) || null, usersTotal: all.length, usersInCanary: selected.length,
  };
}

/**
 * Avança o setor uma etapa (M9-D904 §3.2/§3.3). Etapa fora da sequência: 422 GOV_CANARY_STEP_INVALID; a etapa atual de novo: 200 sem efeito. Com blocker do setor na Torre:
 * 409 GOV_CANARY_BLOCKERS_OPEN; com a última comparação paralela suja: 409 GOV_CANARY_COMPARISON_PENDING. O setor fica travado; etapa, flag e auditoria na mesma transação.
 */
async function advance(tenant, sector, body, transaction) {
  assertSector(sector);
  await flag.lockSector(tenant, sector, transaction);
  const stages = await params.readStages(tenant, transaction);
  const current = flag.percentOf(await flag.readEntry(tenant, sector, transaction));
  const { target, unchanged } = pickTarget(stages, current, body && body.percent);
  if (unchanged) return { ...(await view(tenant, sector, await flag.readEntry(tenant, sector, transaction), stages, transaction)), previousPercent: current, unchanged: true };
  await gate.assertCanAdvance(tenant, sector, transaction);
  const entry = await flag.ensureEntry(tenant, sector, tenant.userId, transaction);
  const note = body && typeof body.reason === 'string' && body.reason.trim() ? ` ${body.reason.trim()}` : '';
  const reason = `Canary ${sector}: ${current}% para ${target}%.${note}`.slice(0, REASON_MAX);
  const saved = await flag.writePercent(tenant, entry, target, reason, tenant.userId, transaction);
  await audit(tenant, AUDIT.ADVANCED, saved, { sector, percent: current }, { sector, percent: target }, reason, transaction);
  return { ...(await view(tenant, sector, saved, stages, transaction)), previousPercent: current, unchanged: false };
}

/**
 * Rollback do setor (M9-D904 §3.4): volta o percentual a 0 em um passo, com motivo obrigatório (422 GOV_CANARY_REASON_REQUIRED). Setor já em 0 devolve 200 sem efeito. Os
 * ganchos da M9-D907 rodam na mesma transação.
 */
async function rollback(tenant, sector, body, transaction) {
  assertSector(sector);
  const reason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, REASON_MAX) : '';
  if (!reason) throw errors.reasonRequired();
  await flag.lockSector(tenant, sector, transaction);
  const stages = await params.readStages(tenant, transaction);
  const entry = await flag.readEntry(tenant, sector, transaction);
  const current = flag.percentOf(entry);
  if (!entry || current === 0) return { ...(await view(tenant, sector, entry, stages, transaction)), previousPercent: current, unchanged: true };
  const before = await members.canaryOf(tenant, sector, current, transaction);
  const saved = await flag.writePercent(tenant, entry, 0, `Rollback do canary ${sector}: ${reason}`.slice(0, REASON_MAX), tenant.userId, transaction);
  const extra = await runRollbackHooks(tenant, sector, { previousPercent: current, reason, usersInCanary: before.selected.length }, transaction);
  await audit(tenant, AUDIT.ROLLED_BACK, saved, { sector, percent: current, usersInCanary: before.selected.length }, { sector, percent: 0, hooks: Object.keys(extra) }, reason, transaction);
  return { ...(await view(tenant, sector, saved, stages, transaction)), previousPercent: current, unchanged: false };
}

/** GET /migration/canary: o estado de cada setor (flag do setor) e os blockers abertos de cada um (Torre). */
async function status(tenant, transaction) {
  const stages = await params.readStages(tenant, transaction);
  const out = [];
  for (const sector of SECTOR_CODES) {
     
    const entry = await flag.readEntry(tenant, sector, transaction);
    const { blockers } = await gate.sectorBlockers(tenant, sector, transaction);
    out.push({ ...(await view(tenant, sector, entry, stages, transaction)), blockersOpen: blockers.length });
  }
  return { stages, sectors: out };
}

module.exports = { advance, rollback, status, assertSector };
