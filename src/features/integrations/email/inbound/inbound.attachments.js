'use strict';

const { sequelize, EmailInboundAttachment } = require('../../../../models');
const { receiveExternalUpload, verifyQuarantine, assertReleased } = require('../../../files/quarantine');
const { ATTACHMENT_STATUS: S, BLOCKED_CODE } = require('./inbound.constants');

const nome = (v) => (v ? String(v).replace(/[\\/\0]/g, '_').slice(0, 255) : null);

/** Estado do anexo pelo que a quarentena decidiu. SÓ passa a apontar para o arquivo depois de `assertReleased` (M9-D247). */
async function settleAttachment(ctx, att, transaction) {
  try {
    const r = await assertReleased(ctx, att.quarantineId, transaction);
    await att.update({ status: S.CLEAN, fileId: r.fileId, sha256: r.sha256, blockCode: null }, { transaction });
  } catch (err) {
    if (err.code === 'INTEGRATION_FILE_QUARANTINED') return att; // ainda em verificação: a próxima rodada decide
    await att.update({ status: err.code === 'INTEGRATION_FILE_INFECTED' ? S.BLOCKED : S.REJECTED, blockCode: BLOCKED_CODE }, { transaction });
  }
  return att;
}

/** Cria a linha do anexo que não pôde entrar (acima do limite ou sem conteúdo): bloqueado, sem conteúdo guardado. */
const blockedRow = (ctx, message, position, item, transaction) => EmailInboundAttachment.create({
  groupId: ctx.groupId, companyId: ctx.companyId, messageId: message.id, position, fileName: nome(item && item.fileName), declaredMime: item && item.contentType ? String(item.contentType).slice(0, 160) : null,
  status: S.BLOCKED, blockCode: BLOCKED_CODE,
}, { transaction });

/**
 * Anexos do e-mail recebido (M9-D235 3.1 item 2): cada um entra em files.quarantine (receiveExternalUpload) e passa pelo antivírus e pela checagem de tipo real (verifyQuarantine); só o liberado
 * é promovido ao módulo de arquivos (CONFIDENTIAL). Infectado ou recusado: descartado pela quarentena, evento de segurança e anexo marcado como bloqueado. Cada anexo roda num savepoint:
 * falha de um (antivírus fora do ar) deixa-o em QUARANTINED para a rodada seguinte, sem derrubar a mensagem.
 */
async function receiveAttachments(ctx, { message, connectionId, items, params }, transaction) {
  const saida = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const buffer = item && item.contentBase64 ? Buffer.from(String(item.contentBase64), 'base64') : null;
    if (i >= params.maxAttachments || !buffer || buffer.length === 0) {
       
      saida.push(await blockedRow(ctx, message, i, item, transaction));
      continue;
    }
     
    const att = await sequelize.transaction({ transaction }, async (sp) => {
      const { quarantine } = await receiveExternalUpload(ctx, { buffer, declaredMime: item.contentType, fileName: nome(item.fileName), connectionId, externalId: `${message.externalMessageId}:${i}`, origin: { flow: 'email_inbound' } }, sp);
      return EmailInboundAttachment.create({
        groupId: ctx.groupId, companyId: ctx.companyId, messageId: message.id, position: i, fileName: nome(item.fileName), declaredMime: item.contentType ? String(item.contentType).slice(0, 160) : null,
        sizeBytes: buffer.length, sha256: quarantine.sha256, quarantineId: quarantine.id, status: S.QUARANTINED,
      }, { transaction: sp });
    });
    if (params.verifyImmediately) {
      try {
         
        await sequelize.transaction({ transaction }, (sp) => verifyQuarantine(ctx, att.quarantineId, sp));
      } catch { /* antivírus indisponível: o anexo segue em quarentena e a rodada seguinte verifica */ }
    }
     
    saida.push(await settleAttachment(ctx, att, transaction));
  }
  return saida;
}

/** Passo da rodada do worker: decide os anexos que ficaram em QUARANTINED depois de a quarentena verificá-los. Devolve quantos mudaram de estado. */
async function settlePendingAttachments(ctx, transaction) {
  const pendentes = await EmailInboundAttachment.findAll({ where: { companyId: ctx.companyId, status: S.QUARANTINED }, order: [['created_at', 'ASC']], limit: 200, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
  let mudaram = 0;
  for (const att of pendentes) {
     
    await settleAttachment(ctx, att, transaction);
    if (att.status !== S.QUARANTINED) mudaram += 1;
  }
  return mudaram;
}

module.exports = { receiveAttachments, settlePendingAttachments, settleAttachment };
