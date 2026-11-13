'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Opportunity } = require('../../models');
const { registerEventConsumer } = require('../../engines/events/consumers');
const { consumeInboundEvent } = require('../../engines/events/inbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { financingStatusLabel } = require('../correspondent/correspondentCrmSync.service');

/**
 * CAD-09 (Marco 3 §9: "Oportunidade pode vincular financing_case do módulo Correspondente. Status do financiamento atualiza CRM por
 * eventos, sem duplicar dados bancários dentro do CRM"). O Correspondente só publica `financing.case.created` /
 * `financing.status.changed` no outbox, na transação da mudança; ESTE consumidor, do módulo CRM, atualiza a oportunidade no despacho:
 *  - o retrato na oportunidade (crm.opportunities.financing_case_id / financing_status / financing_status_at), que só avança: um
 *    evento mais antigo que o retrato atual entra na linha do tempo mas não volta o status;
 *  - um item na linha do tempo da oportunidade (auditoria `crm.opportunity.financing_status_changed`, lida por
 *    opportunityTimeline.service.js como FINANCING_STATUS), com antes e depois.
 * Lê do evento só a referência da oportunidade, o status e o instante: nada bancário (proposta, valores, provider, ids externos)
 * chega ao CRM. Idempotente pela caixa de entrada (consumidor + id do evento). Empresa: a oportunidade é procurada na empresa do
 * evento (RLS + filtro explícito); a de outra empresa não é encontrada e não é tocada. Não muda estágio, dono nem lock_version.
 */
const CONSUMER = 'crm.opportunity.financing_status';
const TIMELINE_ACTION = 'crm.opportunity.financing_status_changed';
const EVENT_TYPES = ['financing.case.created', 'financing.status.changed'];

const UPDATE_SQL = `UPDATE crm.opportunities
  SET financing_case_id = :caseId, financing_status = :status, financing_status_at = :at
  WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL
    AND (financing_status_at IS NULL OR financing_status_at <= :at)
  RETURNING id`;

function snapshotOf(opportunity) {
  return {
    financingCaseId: opportunity.financingCaseId || null,
    financingStatus: opportunity.financingStatus || null,
    financingStatusAt: opportunity.financingStatusAt ? new Date(opportunity.financingStatusAt).toISOString() : null,
  };
}

async function applyFinancingStatus(event, transaction) {
  const payload = event.payloadJson || {};
  // Evento publicado antes do CAD-09 não traz a oportunidade (o CRM daquele caso já foi atualizado pelo caminho antigo).
  if (!payload.opportunityId || !payload.status) return { reason: 'SEM_OPORTUNIDADE' };

  const opportunity = await Opportunity.findOne({
    where: { id: payload.opportunityId, companyId: event.companyId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!opportunity) return { reason: 'OPORTUNIDADE_FORA_DA_EMPRESA' };

  const at = new Date(payload.changedAt || event.occurredAt || Date.now());
  const before = snapshotOf(opportunity);
  const rows = await sequelize.query(UPDATE_SQL, {
    replacements: { caseId: payload.id || event.aggregateId, status: payload.status, at, id: opportunity.id, companyId: event.companyId },
    type: QueryTypes.SELECT,
    transaction,
  });
  const advanced = rows.length > 0;
  const label = financingStatusLabel(payload.status, { manual: Boolean(payload.manualWorkflow) });
  const after = advanced
    ? { financingCaseId: payload.id || event.aggregateId, financingStatus: payload.status, financingStatusAt: at.toISOString() }
    : before;

  await registrarAuditoria(
    {
      groupId: event.groupId,
      companyId: event.companyId,
      actorUserId: null,
      action: TIMELINE_ACTION,
      entityType: 'Opportunity',
      entityId: opportunity.id,
      beforeJson: before,
      afterJson: { ...after, eventStatus: payload.status, previousStatus: payload.previousStatus || null, eventAt: at.toISOString(), sourceEventId: event.id, snapshotAdvanced: advanced },
      reason: event.eventType === 'financing.case.created'
        ? `Financiamento vinculado à oportunidade (caso ${payload.id || event.aggregateId}): ${label}.`
        : `Financiamento vinculado (caso ${payload.id || event.aggregateId}) mudou de status: ${label}.`,
    },
    transaction
  );
  return { reason: advanced ? 'ATUALIZADO' : 'EVENTO_ANTIGO' };
}

function onFinancingEvent(event, transaction) {
  return consumeInboundEvent(
    { sourceId: CONSUMER, eventId: event.id, groupId: event.groupId, companyId: event.companyId, payload: { eventType: event.eventType }, transaction },
    async () => {
      await applyFinancingStatus(event, transaction);
    }
  );
}

EVENT_TYPES.forEach((type) => registerEventConsumer(type, CONSUMER, onFinancingEvent));

module.exports = { CONSUMER, TIMELINE_ACTION, EVENT_TYPES, onFinancingEvent, applyFinancingStatus };
