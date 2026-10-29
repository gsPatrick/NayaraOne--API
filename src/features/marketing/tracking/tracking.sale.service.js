'use strict';

const repo = require('./tracking.events.repository');
const { recordEvent, auditEvent } = require('./tracking.events.service');
const { readWindowDays } = require('./tracking.settings');
const { UNATTRIBUTED } = require('./tracking.catalog');
const { evidenceRequired, notFound } = require('./tracking.errors');

const DAY_MS = 86400000;
const money = (v) => Math.round(Number(v) * 100) / 100;

/**
 * Venda (regra 5): ao contrato ativado / venda registrada procura os toques VÁLIDOS da pessoa na janela. O último toque da janela
 * recebe LAST; o toque que guarda FIRST (dado quando o lead nasceu) fica na evidência. Sem toque, a venda é NÃO ATRIBUÍDA: nunca vai
 * por suposição nem para a última campanha ativa. Evidência da venda: contrato e valor (BRL, 2 casas). Um evento SALE por oportunidade.
 */
async function recordSale({ tenant, actor, opportunityId, contractId, contractValue, occurredAt, now }, transaction) {
  const value = Number(contractValue);
  if (!contractId || !Number.isFinite(value) || value < 0) {
    throw evidenceRequired({ eventType: 'SALE', missing: ['contractId', 'contractValue'] });
  }
  const opportunity = await repo.findOpportunity(opportunityId, transaction);
  if (!opportunity) throw notFound('Oportunidade não encontrada.');
  const at = occurredAt ? new Date(occurredAt) : (now || new Date());
  const windowDays = await readWindowDays(tenant, transaction);
  const touches = await repo.listTouches(opportunity.person_id, new Date(at.getTime() - windowDays * DAY_MS), at, transaction);
  const last = touches.length > 0 ? touches[touches.length - 1] : null;
  const first = last ? await repo.findFirstRoleTouch(opportunity.person_id, transaction) : null;

  const evidence = { contractId, contractValue: money(value), opportunityId, windowDays };
  if (last) {
    evidence.lastTouchEventId = last.id;
    evidence.firstTouchEventId = first ? first.id : null;
  } else {
    evidence.attribution = UNATTRIBUTED;
    evidence.reason = 'SEM_TOQUE_VALIDO_NA_JANELA';
  }
  const { event, replay } = await recordEvent({
    tenant, actor, eventType: 'SALE', personId: opportunity.person_id, opportunityId, campaignId: last ? last.campaign_id : null,
    trackingLinkId: last ? last.tracking_link_id : null, occurredAt: at, dedupeKey: `sale:${opportunityId}`, evidence,
  }, transaction);
  if (replay) return { event, replay: true, attributed: event.evidence_json.attribution !== UNATTRIBUTED };
  if (last) {
    await repo.addRole(last.id, 'LAST', transaction);
    await auditEvent(tenant, actor, 'marketing.attribution.sale_recorded', event, 'Venda atribuída pelo first-touch e last-touch.', transaction);
  } else {
    await auditEvent(tenant, actor, 'marketing.attribution.sale_recorded', event, 'Venda sem toque válido na janela: não atribuída.', transaction);
  }
  return { event, replay: false, attributed: Boolean(last), lastTouchEventId: last ? last.id : null, firstTouchEventId: first ? first.id : null };
}

module.exports = { recordSale };
