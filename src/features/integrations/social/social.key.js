'use strict';

const crypto = require('crypto');

/** Marca do envio imediato na chave (sem horário agendado). */
const IMMEDIATE_SLOT = 'IMMEDIATE';

/** O horário do agendamento como entra na chave: instante ISO em UTC ou IMMEDIATE. */
const slotOf = (scheduledAt) => (scheduledAt instanceof Date ? scheduledAt.toISOString() : IMMEDIATE_SLOT);

/**
 * Chave de idempotência do post (M9-D239 3.2 item 4a): sha256(contentId|contentVersion|connectionId|scheduledSlot). Determinística: o mesmo
 * conteúdo, na mesma versão, para a mesma rede e no mesmo horário gera sempre a mesma chave; reagendar muda o horário e, com ele, a chave.
 */
function socialIdempotencyKey({ contentId, contentVersion, connectionId, scheduledSlot }) {
  return crypto.createHash('sha256').update([contentId, contentVersion, connectionId, scheduledSlot].join('|'), 'utf8').digest('hex');
}

module.exports = { socialIdempotencyKey, slotOf, IMMEDIATE_SLOT };
