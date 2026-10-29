'use strict';

const repo = require('./tracking.events.repository');
const { recordEvent, auditEvent } = require('./tracking.events.service');
const { readWindowDays } = require('./tracking.settings');
const { LEAD_SOURCES } = require('./tracking.catalog');
const { invalidInput, notFound } = require('./tracking.errors');

const DAY_MS = 86400000;

/**
 * Origem do lead (regra 2): grava lead_source e, se houver, campaign_id e tracking_link_id VÁLIDOS (existem, são da empresa e estavam
 * ativos na data do clique). Referência inválida: o lead continua normal, SEM atribuição (attribution_valid = false e nenhuma
 * campanha/link gravados). Cria o evento LEAD_CREATED (um por oportunidade) e entrega o papel FIRST ao primeiro toque da pessoa
 * dentro da janela antes do lead. Idempotente por oportunidade.
 */
async function recordLeadSource({ tenant, actor, opportunityId, leadSource, campaignId, trackingLinkId, clickAt, now }, transaction) {
  const source = typeof leadSource === 'string' ? leadSource.trim().toUpperCase() : '';
  if (!LEAD_SOURCES.includes(source)) throw invalidInput('Origem do lead inválida.', { field: 'leadSource', allowed: LEAD_SOURCES });
  const opportunity = await repo.findOpportunity(opportunityId, transaction);
  if (!opportunity) throw notFound('Oportunidade não encontrada.');

  const at = clickAt ? new Date(clickAt) : (now || new Date());
  let valid = true;
  let linkId = null;
  let resolvedCampaign = null;
  if (trackingLinkId) {
    const link = await repo.findLinkActiveAt(trackingLinkId, at, transaction);
    if (link) { linkId = link.id; resolvedCampaign = link.campaign_id; } else valid = false;
  }
  if (campaignId) {
    if (!(await repo.campaignExists(campaignId, transaction)) || (resolvedCampaign && resolvedCampaign !== campaignId)) valid = false;
    else resolvedCampaign = campaignId;
  }
  if (!valid) { linkId = null; resolvedCampaign = null; }
  await repo.setOpportunitySource(opportunityId, { leadSource: source, campaignId: resolvedCampaign, trackingLinkId: linkId, valid: trackingLinkId || campaignId ? valid : null }, transaction);

  const occurredAt = now || new Date();
  const { event, replay } = await recordEvent({
    tenant, actor, eventType: 'LEAD_CREATED', personId: opportunity.person_id, opportunityId, campaignId: resolvedCampaign, trackingLinkId: linkId, valid,
    occurredAt, dedupeKey: `lead:${opportunityId}`,
    evidence: { opportunityId, leadSource: source, referenceValid: valid, ...(trackingLinkId ? { trackingLinkId } : {}), ...(campaignId ? { campaignId } : {}) },
  }, transaction);
  if (replay) return { event, replay: true, firstTouchEventId: null };

  const windowDays = await readWindowDays(tenant, transaction);
  const touches = await repo.listTouches(opportunity.person_id, new Date(occurredAt.getTime() - windowDays * DAY_MS), occurredAt, transaction);
  let firstTouchEventId = null;
  if (touches.length > 0) {
    firstTouchEventId = touches[0].id;
    await repo.addRole(firstTouchEventId, 'FIRST', transaction);
  }
  await auditEvent(tenant, actor, 'marketing.attribution.lead_recorded', event, valid ? 'Origem do lead registrada.' : 'Origem do lead registrada sem atribuição: referência de rastreio inválida.', transaction);
  return { event, replay: false, firstTouchEventId, attributionValid: valid };
}

module.exports = { recordLeadSource };
