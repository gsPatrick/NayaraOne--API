'use strict';

/**
 * Ouvintes do status de entrega aplicado à mensagem do CRM (sem import entre áreas): quem precisa reagir à entrega ou à falha de uma mensagem (ex.: o pedido de avaliação da
 * M9-D424) registra `fn({ tenant, messageId, status }, transaction)`. Um ouvinte que falha não impede os outros nem desfaz o status já aplicado.
 */
const listeners = [];
const { sequelize } = require('../../../../../models');
const logger = require('../../../../../utils/logger');

const registerDeliveryListener = (fn) => { if (typeof fn !== 'function') throw new TypeError('O ouvinte de entrega deve ser uma função.'); if (!listeners.includes(fn)) listeners.push(fn); };

async function notifyDelivery(event, transaction) {
  for (const fn of listeners) {
    try {
      await sequelize.transaction({ transaction }, (savepoint) => fn(event, savepoint));
    } catch (err) {
      logger.warn({ err: err.message, messageId: event.messageId }, 'marketing.message.delivery_listener_failed');
    }
  }
}

module.exports = { registerDeliveryListener, notifyDelivery };
