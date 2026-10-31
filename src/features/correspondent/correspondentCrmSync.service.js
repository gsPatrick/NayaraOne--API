'use strict';

const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

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
 * syncOpportunityFromFinancingCase — Caderno, Fase 9: "Status relevantes do financing_case
 * atualizam a oportunidade do CRM via eventos (nunca escrita direta)." e "CRM nunca copia
 * documentos restritos — só referência/status."
 *
 * Este projeto ainda não tem um broker/consumidor real de eventos (ver
 * src/documentacao/features/EventsEngine.md — o outbox só loga como stand-in até um broker ser
 * plugado) — então "nunca escrita direta" é garantido aqui registrando uma entrada de AUDITORIA
 * contra a PRÓPRIA Opportunity (entityType: 'Opportunity'), nunca uma escrita de campo
 * (Opportunity.stage, etc). `getOpportunityTimeline` (src/features/crm/opportunityTimeline.service.js,
 * linha ~73) já lê AuditLog por entityType='Opportunity' e mistura no histórico visível da
 * oportunidade — a mesma infraestrutura que telas de contrato/jurídico já usam para aparecer na
 * timeline de uma oportunidade sem tocar os campos de negócio dela (stage/won/lost continuam
 * sendo decisão exclusiva do corretor/gerente, nunca do módulo de financiamento).
 *
 * Não escreve nada — só audita — quando `financingCase.opportunityId` é nulo (caso sem CRM
 * vinculado, maioria dos casos nesta fase).
 */
async function syncOpportunityFromFinancingCase(financingCase, normalizedStatus, transaction, { manual = false } = {}) {
  if (!financingCase.opportunityId) return null;

  // Provider de workflow manual: nada foi enviado pelo sistema, o caso só foi registrado para a pessoa levar ao banco.
  const label = manual && normalizedStatus === 'SUBMITTED'
    ? 'Registrado para envio manual ao banco'
    : (STATUS_LABEL_PT[normalizedStatus] || normalizedStatus);
  return registrarAuditoria(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      actorUserId: null,
      action: 'crm.opportunity.financing_status_changed',
      entityType: 'Opportunity',
      entityId: financingCase.opportunityId,
      reason: `Financiamento vinculado (caso ${financingCase.id}) mudou de status: ${label}.`,
    },
    transaction
  );
}

module.exports = { syncOpportunityFromFinancingCase, STATUS_LABEL_PT };
