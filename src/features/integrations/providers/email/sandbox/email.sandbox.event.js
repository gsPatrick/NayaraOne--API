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

/**
 * Mensagem RECEBIDA (M9-D235): o conteúdo vai só em `private` (o tratador do domínio o lê na mesma transação; nunca vai ao outbox, que leva só o identificador). Sem recurso nem status:
 * a ordem dos estados e a ligação a envio não se aplicam a e-mail recebido.
 */
function emailReceivedEvent(msg) {
  return {
    eventType: 'integration.email.inbound',
    resourceRef: null,
    externalStatus: null,
    idempotencyKey: null,
    data: { kind: 'INBOUND', externalMessageId: msg.id },
    private: { from: msg.from || null, to: msg.to || [], subject: msg.subject || '', text: msg.text || '', inReplyTo: msg.inReplyTo || null, references: msg.references || null, attachments: msg.attachments || [] },
  };
}

module.exports = { emailEvent, emailReceivedEvent, KINDS };
