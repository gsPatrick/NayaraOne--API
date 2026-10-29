'use strict';

/**
 * Estados de crm.messages que o cap e o cooldown contam (M9-D416): tudo que o provedor ACEITOU ou pode ter entregue. E-mail não
 * confirma entrega, por isso SENT já conta (esperar DELIVERED faria o cap nunca fechar). FAILED, UNDELIVERED e BOUNCED não contam.
 */
const COUNTED_MESSAGE_STATUSES = Object.freeze(['SENT', 'DELIVERED', 'READ', 'UNKNOWN']);
const NOT_COUNTED_MESSAGE_STATUSES = Object.freeze(['FAILED', 'UNDELIVERED', 'BOUNCED']);

/** Ação de envio reservada (PENDING) ou aceita (OK) dentro de uma run: entra na conta do cap para fechar a corrida. */
const RESERVED_ACTION_STATUSES = Object.freeze(['PENDING', 'OK']);
const NON_TERMINAL_RUN_STATUSES = Object.freeze(['STARTED', 'WAITING']);
const SEND_ACTION_TYPE = 'SEND_MESSAGE';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

module.exports = {
  COUNTED_MESSAGE_STATUSES, NOT_COUNTED_MESSAGE_STATUSES, RESERVED_ACTION_STATUSES, NON_TERMINAL_RUN_STATUSES, SEND_ACTION_TYPE, DAY_MS, HOUR_MS,
};
