'use strict';

/** Estados internos da mensagem (M9-D234 3.1). DELIVERED, BOUNCED_*, COMPLAINED e FAILED vêm do evento do provedor; SENT é a resposta do envio. */
const STATUSES = Object.freeze(['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'COMPLAINED', 'FAILED']);
/** Estados que o evento do provedor pode aplicar. */
const EVENT_STATUSES = Object.freeze(['DELIVERED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'COMPLAINED', 'FAILED']);

/** Escala de documentos (PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED): o teto de anexo é sempre abaixo de RESTRICTED (= SENSITIVE da escala de integração, D219). */
const ATTACHMENT_SCALE = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']);

/** Tipo de conteúdo esperado para cada extensão conhecida; extensão que o administrador acrescenta e não está aqui não tem conferência de tipo de conteúdo. */
const MIME_BY_EXTENSION = Object.freeze({
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
});

module.exports = { STATUSES, EVENT_STATUSES, ATTACHMENT_SCALE, MIME_BY_EXTENSION };
