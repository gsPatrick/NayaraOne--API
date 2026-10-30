'use strict';

const crypto = require('node:crypto');
const { FileQuarantine } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const storage = require('../../integrations/storage');
const { readQuarantineParams } = require('./quarantine.params');
const { STATUS, AREA } = require('./quarantine.constants');

/** Chave de origem para a idempotência: a connection e o id externo; sem eles, o fluxo e o host de onde o conteúdo foi baixado. */
function originKeyOf({ connectionId, externalId, origin }) {
  if (externalId) return `${connectionId || '-'}|${String(externalId).slice(0, 160)}`;
  return `${connectionId || '-'}|${origin && origin.flow ? origin.flow : '-'}|${origin && origin.host ? origin.host : '-'}`;
}

/**
 * receiveExternalUpload — todo arquivo que chega de fora entra AQUI (M9-D247 3.1 item 1): grava o conteúdo na área de quarentena do armazenamento (company/<id>/quarantine/, sem
 * leitura por usuário nem URL assinada) e a linha com status QUARANTINED, hash SHA-256, origem e horário. O mesmo arquivo da mesma origem (hash + origem) recebido de novo não cria nada: devolve
 * a linha existente (`created:false`) e é verificado uma vez só. Acima de `integration.upload.max_bytes` o conteúdo nem é guardado: a linha nasce REJECTED_SIZE (com o hash).
 * `item`: { buffer, declaredMime, fileName?, connectionId?, externalId?, origin? }. Devolve { quarantine, created }.
 */
async function receiveExternalUpload(tenant, item, transaction) {
  const params = await readQuarantineParams(tenant, transaction);
  const buffer = item.buffer;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const originKey = originKeyOf(item);
  const ja = await FileQuarantine.findOne({ where: { companyId: tenant.companyId, sha256, originKey }, transaction });
  if (ja) return { quarantine: ja, created: false };
  const agora = new Date();
  const base = {
    groupId: tenant.groupId, companyId: tenant.companyId, connectionId: item.connectionId || null, externalId: item.externalId ? String(item.externalId).slice(0, 160) : null, originKey,
    fileName: item.fileName ? String(item.fileName).slice(0, 255) : null, declaredMime: item.declaredMime ? String(item.declaredMime).slice(0, 160) : null, sizeBytes: buffer.length, sha256,
    receivedAt: agora, expiresAt: new Date(agora.getTime() + params.ttlHours * 3600000),
  };
  let row;
  if (buffer.length > params.maxBytes) {
    row = await FileQuarantine.create({ ...base, status: STATUS.REJECTED_SIZE, reason: 'SIZE', verifiedAt: agora }, { transaction });
  } else {
    const key = storage.buildKey(tenant.companyId, `${AREA}/${crypto.randomUUID()}-${sha256.slice(0, 12)}`);
    await storage.putObject(tenant, { key, body: buffer, contentType: 'application/octet-stream', sha256, quarantineAccess: true }, transaction);
    row = await FileQuarantine.create({ ...base, storageKey: key, status: STATUS.QUARANTINED }, { transaction });
  }
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'files.quarantine.received', entityType: 'FileQuarantine', entityId: row.id,
    afterJson: { status: row.status, sha256, sizeBytes: buffer.length, connectionId: row.connectionId }, reason: 'Upload externo recebido: fica em quarentena até a verificação de segurança.',
  }, transaction);
  return { quarantine: row, created: true };
}

module.exports = { receiveExternalUpload, originKeyOf };
