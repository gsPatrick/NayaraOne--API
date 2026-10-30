'use strict';

/** E-mail recebido (M9-D235): estados dos anexos, tipos de dado pessoal e mensagens em português. */
const ATTACHMENT_STATUS = Object.freeze({ QUARANTINED: 'QUARANTINED', CLEAN: 'CLEAN', BLOCKED: 'BLOCKED', REJECTED: 'REJECTED' });
const BLOCKED_CODE = 'INTEGRATION_EMAIL_ATTACHMENT_BLOCKED';
const BLOCKED_MESSAGE = 'Anexo bloqueado pela verificação de segurança.';
const PAN_BODY = '[conteúdo removido: a mensagem trazia um número de cartão de crédito]';
const PAN_ERROR = 'INTEGRATION_EMAIL_INBOUND_CARD_NUMBER';
const LINK_KINDS = Object.freeze({ REPLY: 'REPLY', REFERENCE: 'REFERENCE', MANUAL: 'MANUAL' });
const DUPLICATE_CODE = 'INTEGRATION_EMAIL_INBOUND_DUPLICATE_IGNORED';

module.exports = { ATTACHMENT_STATUS, BLOCKED_CODE, BLOCKED_MESSAGE, PAN_BODY, PAN_ERROR, LINK_KINDS, DUPLICATE_CODE };
