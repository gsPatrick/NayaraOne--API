'use strict';

/**
 * Evento interno normalizado da mensageria (M9-D229 3.1 `toInternalEvent`): todo adapter de mensagem devolve o MESMO formato, qualquer que seja o webhook do fornecedor.
 * `data` vai ao outbox (só identificadores, nunca o texto nem o telefone); `private` é lido só pelo tratador do CRM no worker (remetente, nome e conteúdo da mensagem recebida).
 * Tipos: `integration.messaging.message.status` (status de uma mensagem enviada) e `integration.messaging.message.inbound` (mensagem recebida do cliente).
 */
const KINDS = Object.freeze({ STATUS: 'STATUS', INBOUND: 'INBOUND' });

const texto = (v, max = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));

function messagingEvent({ kind, externalMessageId, externalStatus = null, idempotencyKey = null, occurredAt = null, from = null, name = null, text = null, mediaRef = null, mimeType = null }) {
  const sufixo = kind === KINDS.INBOUND ? 'inbound' : 'status';
  return {
    eventType: `integration.messaging.message.${sufixo}`,
    resourceRef: texto(externalMessageId),
    externalStatus: kind === KINDS.STATUS ? texto(externalStatus, 40) : null,
    idempotencyKey: texto(idempotencyKey),
    data: { kind, externalMessageId: texto(externalMessageId), occurredAt: texto(occurredAt, 40) },
    private: { from: texto(from, 40), name: texto(name, 200), text: typeof text === 'string' ? text.slice(0, 4096) : null, mediaRef: texto(mediaRef, 400), mimeType: texto(mimeType, 120) },
  };
}

module.exports = { messagingEvent, KINDS };
