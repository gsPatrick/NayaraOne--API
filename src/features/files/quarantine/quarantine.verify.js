'use strict';

const { FileQuarantine, File } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { recordError } = require('../../integrations/errors');
const storage = require('../../integrations/storage');
const { resolveAntivirusAdapter } = require('../../people/adapters/resolveDocumentAdapters');
const filesService = require('../files.service');
const { readQuarantineParams } = require('./quarantine.params');
const { runChecks } = require('./quarantine.checks');
const { STATUS, PROMOTED_CLASSIFICATION } = require('./quarantine.constants');

const audit = (tenant, row, action, reason, extra, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action, entityType: 'FileQuarantine', entityId: row.id, afterJson: { status: row.status, sha256: row.sha256, reason: row.reason, ...extra }, reason,
}, transaction);

/** Descarta o conteúdo da área de quarentena (a linha com o hash fica). */
async function discard(tenant, row, transaction) {
  if (!row.storageKey) return;
  await storage.deleteObject(tenant, { key: row.storageKey, purpose: 'QUARANTINE_DISCARD' }, transaction);
  await row.update({ storageKey: null }, { transaction });
}

async function finish(tenant, row, patch, transaction) {
  await row.update({ ...patch, verifiedAt: new Date() }, { transaction });
  await discard(tenant, row, transaction);
}

/**
 * verifyQuarantine — UMA verificação (M9-D247 3.1 itens 2 e 3). Trava a linha e relê o estado (duas rodadas simultâneas verificam uma vez). Ordem: antivírus (INFECTED: descartado, evento de segurança
 * `file.infected` com o hash e auditoria), depois tipo real, tamanho, arquivo compactado, conteúdo ativo, metadados e dado pessoal (quarantine.checks). Rejeitado: descartado com o motivo (e erro HIGH quando o
 * conteúdo é um executável disfarçado). Limpo: sem metadados de imagem, promovido ao módulo `files` com classificação CONFIDENTIAL e o conteúdo da quarentena é removido. Devolve a linha.
 */
async function verifyQuarantine(tenant, id, transaction) {
  const row = await FileQuarantine.findOne({ where: { id, companyId: tenant.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row || row.status !== STATUS.QUARANTINED) return row;
  const params = await readQuarantineParams(tenant, transaction);
  const lido = await storage.getObject(tenant, { key: row.storageKey, expectedSha256: row.sha256, quarantineAccess: true }, transaction);
  const antivirus = await resolveAntivirusAdapter(tenant, transaction);
  const scan = await antivirus.scan(lido.buffer);
  if (!scan.clean) {
    await finish(tenant, row, { status: STATUS.INFECTED, reason: 'MALWARE', signature: scan.signature ? String(scan.signature).slice(0, 160) : null }, transaction);
    await publishDomainEvent({
      groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'FileQuarantine', aggregateId: row.id, eventType: 'file.infected',
      payload: { quarantineId: row.id, sha256: row.sha256, signature: row.signature, connectionId: row.connectionId }, idempotencyKey: `file.infected:${row.id}`,
    }, transaction);
    await audit(tenant, row, 'files.quarantine.infected', 'Arquivo infectado: descartado, hash registrado e evento de segurança publicado.', { signature: row.signature }, transaction);
    return row;
  }
  const r = runChecks(lido.buffer, { declaredMime: row.declaredMime, params });
  if (r.status !== STATUS.CLEAN) {
    await finish(tenant, row, { status: r.status, reason: r.reason, detectedMime: r.detectedMime || null }, transaction);
    if (r.executable) {
      await recordError(tenant, {
        providerCode: null, connectionId: row.connectionId, source: 'DISPATCH', operation: 'files.quarantine', errorClass: 'VALIDATION', severity: 'HIGH', errorCode: 'INTEGRATION_FILE_DISGUISED_EXECUTABLE',
        message: 'Um arquivo recebido de fora se passava por outro tipo, mas o conteúdo é um programa executável: foi descartado.', payload: { quarantineId: row.id, sha256: row.sha256 }, allowlist: ['quarantineId', 'sha256'],
      }, transaction);
    }
    await audit(tenant, row, 'files.quarantine.rejected', `Arquivo recusado pela verificação (${row.reason}): descartado.`, { detectedMime: r.detectedMime || null }, transaction);
    return row;
  }
  const file = await filesService.uploadFile({
    groupId: tenant.groupId, companyId: tenant.companyId, fileName: row.fileName || `externo-${row.sha256.slice(0, 12)}`, mimeType: r.detectedMime, contentBase64: r.buffer.toString('base64'), category: 'generic',
  }, null, transaction);
  await File.update({ classification: PROMOTED_CLASSIFICATION }, { where: { id: file.id }, transaction });
  await finish(tenant, row, { status: STATUS.CLEAN, detectedMime: r.detectedMime, cleanSha256: r.sha256, metadataStripped: r.stripped, piiDetected: r.piiDetected, promotedFileId: file.id }, transaction);
  await audit(tenant, row, 'files.quarantine.promoted', 'Arquivo limpo: promovido ao módulo de arquivos como CONFIDENTIAL.', { fileId: file.id, metadataStripped: r.stripped, piiDetected: r.piiDetected }, transaction);
  return row;
}

module.exports = { verifyQuarantine };
