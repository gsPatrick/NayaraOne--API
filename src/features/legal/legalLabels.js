'use strict';

/**
 * Rótulos em português dos códigos do Jurídico usados em mensagens e resumos (Caderno M5 §5 "Estado do contrato";
 * linha do tempo, recusas). O código continua nos campos estruturados; o texto para pessoas usa o rótulo.
 * Código sem rótulo conhecido aparece como "(não informado)" em vez do código cru.
 */
const CONTRACT_STATUS = {
  DRAFT: 'Montagem', DOCUMENTS_PENDING: 'Faltam documentos', LEGAL_REVIEW: 'Revisão jurídica', APPROVED: 'Versão homologada',
  SIGNING: 'Em assinatura', SIGNED: 'Assinado', ACTIVE: 'Em vigor', SUSPENDED: 'Suspenso', TERMINATED: 'Encerrado/rescindido',
  CLOSED: 'Arquivado', CANCELLED: 'Cancelado (legado)',
};
const AMENDMENT_STATUS = { DRAFT: 'em rascunho', SIGNED: 'assinado' };
const NOTICE_STATUS = { DRAFT: 'rascunho', PENDING_REVIEW: 'em revisão', APPROVED: 'aprovada', SENT: 'enviada', DELIVERED: 'entregue', REJECTED: 'recusada' };
const NOTICE_CHANNEL = { EMAIL: 'e-mail', WHATSAPP: 'WhatsApp', POSTAL_MAIL: 'correio', IN_PERSON: 'em mãos', OTHER: 'outro canal' };
const COLLECTION_STATUS = { OPEN: 'em aberto', NEGOTIATING: 'em negociação', AGREEMENT: 'com acordo', RESOLVED: 'resolvida', CANCELLED: 'cancelada' };
const INSPECTION_TYPE = {
  ENTRY: 'entrada', EXIT: 'saída', INTERMEDIATE: 'intermediária', FINAL: 'final', CHECK_IN: 'entrada', CHECK_OUT: 'saída', PERIODIC: 'intermediária',
};

const label = (map, code) => (code && map[code]) || '(não informado)';

module.exports = {
  CONTRACT_STATUS, AMENDMENT_STATUS, NOTICE_STATUS, NOTICE_CHANNEL, COLLECTION_STATUS, INSPECTION_TYPE,
  contractStatusLabel: (c) => label(CONTRACT_STATUS, c),
  amendmentStatusLabel: (c) => label(AMENDMENT_STATUS, c),
  noticeStatusLabel: (c) => label(NOTICE_STATUS, c),
  noticeChannelLabel: (c) => label(NOTICE_CHANNEL, c),
  collectionStatusLabel: (c) => label(COLLECTION_STATUS, c),
  inspectionTypeLabel: (c) => label(INSPECTION_TYPE, c),
};
