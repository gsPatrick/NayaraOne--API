'use strict';

const { Op } = require('sequelize');
const logger = require('../../../utils/logger');
const { sequelize, FileQuarantine } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const storage = require('../../integrations/storage');
const { readWorkerParams } = require('../../integrations/dispatch/worker/worker.params');
const { verifyQuarantine } = require('./quarantine.verify');
const { STATUS } = require('./quarantine.constants');

/** Arquivo sem resultado depois de `integration.upload.quarantine_ttl_hours` (M9-D247 3.1 item 4): descartado como EXPIRED, hash mantido. */
async function expireQuarantine(tenant, { now = new Date() } = {}, transaction) {
  const vencidos = await FileQuarantine.findAll({
    where: { companyId: tenant.companyId, status: STATUS.QUARANTINED, expiresAt: { [Op.lte]: now } }, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  for (const row of vencidos) {
    if (row.storageKey) await storage.deleteObject(tenant, { key: row.storageKey, purpose: 'QUARANTINE_DISCARD' }, transaction); // eslint-disable-line no-await-in-loop
    await row.update({ status: STATUS.EXPIRED, reason: 'TTL', storageKey: null, verifiedAt: now }, { transaction }); // eslint-disable-line no-await-in-loop
    await registrarAuditoria({ // eslint-disable-line no-await-in-loop
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'files.quarantine.expired', entityType: 'FileQuarantine', entityId: row.id,
      afterJson: { status: STATUS.EXPIRED, sha256: row.sha256 }, reason: 'Sem resultado da verificação dentro do prazo: arquivo descartado.',
    }, transaction);
  }
  return vencidos.length;
}

/** Passo da rodada do worker: descarta o vencido e verifica os pendentes (no máximo `worker_batch_size` por rodada, cada um num savepoint: a falha de um não derruba os outros). */
async function runQuarantineCycle(tenant, { now = new Date() } = {}, transaction) {
  const expirados = await expireQuarantine(tenant, { now }, transaction);
  const { batchSize } = await readWorkerParams(tenant, transaction);
  const pendentes = await FileQuarantine.findAll({ where: { companyId: tenant.companyId, status: STATUS.QUARANTINED }, order: [['received_at', 'ASC']], limit: batchSize, transaction });
  let verificados = 0;
  for (const p of pendentes) {
    try {
      await sequelize.transaction({ transaction }, (savepoint) => verifyQuarantine(tenant, p.id, savepoint)); // eslint-disable-line no-await-in-loop
      verificados += 1;
    } catch (err) {
      logger.warn({ quarantineId: p.id, err: err.message, code: err.code }, 'Quarentena: a verificação não pôde rodar; o arquivo segue em quarentena.');
    }
  }
  return { expirados, verificados };
}

module.exports = { expireQuarantine, runQuarantineCycle };
