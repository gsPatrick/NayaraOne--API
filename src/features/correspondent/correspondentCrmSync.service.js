'use strict';

// Nomes em português dos status normalizados — nunca o enum cru na mensagem visível ao usuário
// (mesmo cuidado já aplicado em todo o front do Marco 8).
const STATUS_LABEL_PT = {
  DRAFT: 'Rascunho',
  DOCUMENTS_PENDING: 'Documentos pendentes',
  READY_TO_SUBMIT: 'Pronto para envio',
  SUBMITTED: 'Enviado ao banco',
  UNDER_ANALYSIS: 'Em análise',
  PENDING_CUSTOMER: 'Aguardando documentos do cliente',
  PENDING_PROPERTY: 'Aguardando documentação do imóvel',
  APPROVED: 'Aprovado',
  REJECTED: 'Rejeitado',
  CONTRACTING: 'Em contratação',
  COMPLETED: 'Concluído',
  CANCELED: 'Cancelado',
};

/**
 * Rótulo em português do status do caso, com a variante do provider de workflow manual (nada foi enviado pelo sistema: o caso só
 * foi registrado para a pessoa levar ao banco). CAD-09 (Marco 3 §9): o CRM não é mais escrito daqui — a mudança de status publica
 * `financing.status.changed` no outbox (correspondentEvents.service.js) e o consumidor do CRM (crm/financingStatus.consumer.js)
 * atualiza a oportunidade no despacho.
 */
function financingStatusLabel(status, { manual = false } = {}) {
  if (manual && status === 'SUBMITTED') return 'Registrado para envio manual ao banco';
  return STATUS_LABEL_PT[status] || status;
}

module.exports = { STATUS_LABEL_PT, financingStatusLabel };
