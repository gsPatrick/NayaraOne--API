'use strict';

const { Message, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { invoke } = require('../../integrations/registry/adapterInvoke');
const { messagingStatus: { shouldApply } } = require('../../integrations');
const { updateMessageStatus } = require('../messages.service');

/**
 * Consulta o status da mensagem no fornecedor (`getStatus`, M9-D229 3.1) quando a connection tem a capability, e aplica pela mesma regra do webhook (só avança). É a
 * evidência alternativa ao webhook perdido. Sem a capability: 422 INTEGRATION_CAPABILITY_UNSUPPORTED. Devolve { message, changed }.
 */
async function refreshStatus(ctx, messageId, transaction) {
  const message = await Message.findOne({ where: { id: messageId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message) throw AppError.notFound('Mensagem não encontrada.', 'MESSAGE_NOT_FOUND');
  if (!message.connectionId || !message.externalMessageId || message.direction !== 'OUTBOUND') {
    throw AppError.conflict('Esta mensagem ainda não foi aceita por um fornecedor: não há status para consultar.', 'INTEGRATION_MESSAGING_NOT_SUBMITTED');
  }
  const connection = await IntegrationConnection.findOne({ where: { id: message.connectionId, companyId: ctx.companyId }, transaction });
  const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
  if (!adapter.supports('getStatus')) throw AppError.unprocessable('O fornecedor não suporta esta operação.', 'INTEGRATION_CAPABILITY_UNSUPPORTED');
  const resposta = await invoke(adapter, 'getStatus', { externalResourceId: message.externalMessageId }, { tenant: ctx, transaction, meta: { transaction } });
  if (!shouldApply(message.deliveryStatus, resposta.status)) return { message, changed: false };
  await updateMessageStatus(message.id, resposta.status, null, transaction, { fromProvider: true });
  return { message: await message.reload({ transaction }), changed: true };
}

module.exports = { refreshStatus };
