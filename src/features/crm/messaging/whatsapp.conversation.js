'use strict';

const { Op } = require('sequelize');
const { sequelize, CrmChannel, CrmConversation, CrmConversationLink } = require('../../../models');
const E = require('./whatsapp.errors');

const CHANNEL = 'WHATSAPP';
const trava = (chave, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: chave }, transaction });

/** A linha da empresa no canal, com id interno estável (criada no primeiro uso). */
async function ensureChannel(ctx, transaction) {
  await trava(`wa-channel|${ctx.companyId}`, transaction);
  const ja = await CrmChannel.findOne({ where: { companyId: ctx.companyId, kind: CHANNEL }, transaction });
  return ja || CrmChannel.create({ groupId: ctx.groupId, companyId: ctx.companyId, kind: CHANNEL }, { transaction });
}

/** Par externo vigente de um recurso interno numa connection; o par de OUTRA connection que ainda estava vigente fica superado (a troca de fornecedor, M9-D221). */
async function ensureLink(ctx, { kind, internalId, connectionId, externalId }, transaction) {
  const agora = new Date();
  await CrmConversationLink.update({ supersededAt: agora }, { where: { companyId: ctx.companyId, kind, internalId, supersededAt: null, connectionId: { [Op.ne]: connectionId } }, transaction });
  const vigente = await CrmConversationLink.findOne({ where: { companyId: ctx.companyId, kind, internalId, connectionId, supersededAt: null }, transaction });
  if (vigente) return vigente;
  return CrmConversationLink.create({ groupId: ctx.groupId, companyId: ctx.companyId, kind, internalId, connectionId, externalId: String(externalId).slice(0, 160) }, { transaction });
}

/**
 * A conversa interna da pessoa no WhatsApp (M9-D230 3.5): mesmo id antes e depois de qualquer troca de fornecedor. Cria a conversa e o canal no primeiro uso. Com `connection`, garante o par
 * externo vigente (connection + id no fornecedor: o número do contato para a conversa; o número/identificador da linha para o canal) e supera o par da connection antiga.
 */
async function ensureConversation(ctx, personId, { connection, externalConversationId } = {}, transaction) {
  await trava(`wa-conv|${ctx.companyId}|${personId}`, transaction);
  const canal = await ensureChannel(ctx, transaction);
  let conversa = await CrmConversation.findOne({ where: { companyId: ctx.companyId, personId, channel: CHANNEL }, transaction });
  if (!conversa) conversa = await CrmConversation.create({ groupId: ctx.groupId, companyId: ctx.companyId, personId, channel: CHANNEL, channelId: canal.id }, { transaction });
  else if (!conversa.channelId) await conversa.update({ channelId: canal.id }, { transaction });
  if (connection) {
    await ensureLink(ctx, { kind: 'CONVERSATION', internalId: conversa.id, connectionId: connection.id, externalId: externalConversationId || personId }, transaction);
    await ensureLink(ctx, { kind: 'CHANNEL', internalId: canal.id, connectionId: connection.id, externalId: (connection.configJson || {}).external_channel_id || connection.id }, transaction);
  }
  return conversa;
}

/** O cliente escreveu agora (ou em `quando`): reabre a janela de atendimento. */
async function markInbound(conversa, quando, transaction) {
  const instante = quando instanceof Date ? quando : new Date();
  if (!conversa.lastInboundAt || instante > conversa.lastInboundAt) await conversa.update({ lastInboundAt: instante }, { transaction });
}

/** Texto livre e mídia só dentro da janela: 24 h (parâmetro) desde a última mensagem do cliente; quem nunca escreveu não tem janela. */
function assertSessionWindow(conversa, params, agora = new Date()) {
  const ultimo = conversa && conversa.lastInboundAt ? new Date(conversa.lastInboundAt).getTime() : null;
  if (ultimo === null || agora.getTime() - ultimo > params.sessionWindowH * 3600000) throw E.outsideWindow(params.sessionWindowH);
}

module.exports = { ensureChannel, ensureConversation, ensureLink, markInbound, assertSessionWindow };
