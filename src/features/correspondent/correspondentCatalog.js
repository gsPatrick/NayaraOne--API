'use strict';

/**
 * Catálogo compartilhado do correspondente: rótulos de provider e de etapa do caso num lugar só
 * (a lista de providers vem do registry de adapters, não de uma cópia no código de Parâmetros).
 */
const { listFinancingProviderCodes } = require('./adapters/resolveFinancingProviderAdapter');

const PROVIDER_LABEL = { sandbox: 'Sandbox (simulação)', manual: 'Manual (conduzido com o banco fora do sistema)' };

const CASE_STATUS_LABEL = {
  DRAFT: 'Rascunho',
  DOCUMENTS_PENDING: 'Documentos pendentes',
  READY_TO_SUBMIT: 'Pronto para envio',
  SUBMITTED: 'Enviado ao banco',
  UNDER_ANALYSIS: 'Em análise',
  PENDING_CUSTOMER: 'Aguardando o cliente',
  PENDING_PROPERTY: 'Aguardando o imóvel',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
  CONTRACTING: 'Em contratação',
  COMPLETED: 'Concluído',
  CANCELED: 'Cancelado',
};
const CASE_STATUSES = Object.keys(CASE_STATUS_LABEL);

function providerLabel(code) {
  return PROVIDER_LABEL[code] || String(code);
}

function caseStatusLabel(status) {
  return CASE_STATUS_LABEL[status] || String(status);
}

function knownProviders() {
  return listFinancingProviderCodes();
}

module.exports = { PROVIDER_LABEL, CASE_STATUS_LABEL, CASE_STATUSES, providerLabel, caseStatusLabel, knownProviders };
