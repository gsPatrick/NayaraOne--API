'use strict';

/**
 * Evento interno normalizado de e-mail (M9-D234 3.1): igual para qualquer provedor. `data` vai ao outbox (só ids e o tipo do fato); `private` só o tratador do domínio lê,
 * na mesma transação (motivo informado pelo provedor, horário), e nunca vai ao outbox. kind: DELIVERED, BOUNCED_SOFT, BOUNCED_HARD, COMPLAINED ou FAILED.
 */
const KINDS = Object.freeze({ DELIVERED: 'DELIVERED', BOUNCED_SOFT: 'BOUNCED_SOFT', BOUNCED_HARD: 'BOUNCED_HARD', COMPLAINED: 'COMPLAINED', FAILED: 'FAILED' });

function emailEvent({ kind, messageId, reason = null, occurredAt = null }) {
  return {
    eventType: 'integration.email.event',
    resourceRef: messageId,
    externalStatus: kind,
    idempotencyKey: null,
    data: { kind, externalMessageId: messageId },
    private: { reason, occurredAt },
  };
}

module.exports = { emailEvent, KINDS };
