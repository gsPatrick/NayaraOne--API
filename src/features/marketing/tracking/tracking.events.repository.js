'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL de marketing.attribution_events e das leituras de apoio (M9-D431). RLS por grupo e empresa vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLUMNS = 'id, person_id, opportunity_id, campaign_id, tracking_link_id, event_type, touch_roles, evidence_json, valid, occurred_at, dedupe_key';

/** Insere o evento; a mesma dedupe_key devolve o evento já gravado (replay). */
async function insertEvent(tenant, actor, v, transaction) {
  const [created] = await run(
    `INSERT INTO marketing.attribution_events (id, group_id, company_id, person_id, opportunity_id, campaign_id, tracking_link_id, event_type,
        touch_roles, evidence_json, valid, occurred_at, dedupe_key, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :personId, :opportunityId, :campaignId, :trackingLinkId, :eventType,
        CAST(:roles AS text[]), CAST(:evidence AS jsonb), :valid, :occurredAt, :dedupeKey, :actor, :actor)
     ON CONFLICT (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, personId: v.personId || null, opportunityId: v.opportunityId || null,
      campaignId: v.campaignId || null, trackingLinkId: v.trackingLinkId || null, eventType: v.eventType,
      roles: `{${(v.touchRoles || []).join(',')}}`, evidence: JSON.stringify(v.evidence), valid: v.valid !== false, occurredAt: v.occurredAt,
      dedupeKey: v.dedupeKey || null, actor: actor || null },
    transaction
  );
  if (created) return { event: created, replay: false };
  const [existing] = await run(`SELECT ${COLUMNS} FROM marketing.attribution_events WHERE company_id = :companyId AND dedupe_key = :dedupeKey`,
    { companyId: tenant.companyId, dedupeKey: v.dedupeKey }, transaction);
  return { event: existing, replay: true };
}

/** Toques da pessoa: CLICK identificado e válido na janela [from, to], do mais antigo ao mais novo. */
async function listTouches(personId, from, to, transaction) {
  return run(
    `SELECT ${COLUMNS} FROM marketing.attribution_events WHERE event_type = 'CLICK' AND person_id = :personId AND valid
        AND occurred_at >= :from AND occurred_at <= :to ORDER BY occurred_at, id`,
    { personId, from, to }, transaction
  );
}

/** Toque que guarda o papel FIRST da pessoa (atribuído quando o lead nasceu): o mais recente com o papel. */
async function findFirstRoleTouch(personId, transaction) {
  const [row] = await run(
    `SELECT ${COLUMNS} FROM marketing.attribution_events WHERE event_type = 'CLICK' AND person_id = :personId AND valid AND 'FIRST' = ANY(touch_roles)
      ORDER BY occurred_at DESC, id LIMIT 1`, { personId }, transaction
  );
  return row || null;
}

async function addRole(eventId, role, transaction) {
  await run(
    `UPDATE marketing.attribution_events SET touch_roles = (SELECT COALESCE(array_agg(DISTINCT r ORDER BY r), '{}') FROM unnest(touch_roles || ARRAY[CAST(:role AS text)]) r),
        updated_at = now() WHERE id = :eventId RETURNING id`, { eventId, role }, transaction
  );
}

async function findOpportunity(opportunityId, transaction) {
  const [row] = await run('SELECT id, person_id FROM crm.opportunities WHERE id = :opportunityId AND deleted_at IS NULL', { opportunityId }, transaction);
  return row || null;
}

async function setOpportunitySource(opportunityId, v, transaction) {
  await run(
    `UPDATE crm.opportunities SET lead_source = :leadSource, campaign_id = :campaignId, tracking_link_id = :trackingLinkId,
        attribution_valid = :valid WHERE id = :opportunityId RETURNING id`,
    { opportunityId, leadSource: v.leadSource, campaignId: v.campaignId || null, trackingLinkId: v.trackingLinkId || null, valid: v.valid }, transaction
  );
}

/** Link ativo na data do clique: existe, é da empresa (RLS), não revogado e vigente em `at`. */
async function findLinkActiveAt(trackingLinkId, at, transaction) {
  const [row] = await run(
    `SELECT id, campaign_id FROM marketing.tracking_links WHERE id = :trackingLinkId AND deleted_at IS NULL AND status <> 'REVOKED'
        AND created_at <= :at AND (expires_at IS NULL OR expires_at > :at)`, { trackingLinkId, at }, transaction
  );
  return row || null;
}

async function campaignExists(campaignId, transaction) {
  return (await run('SELECT 1 AS ok FROM marketing.campaigns WHERE id = :campaignId AND deleted_at IS NULL', { campaignId }, transaction)).length > 0;
}

async function findMessage(messageId, transaction) {
  const [row] = await run('SELECT id, person_id, channel FROM crm.messages WHERE id = :messageId', { messageId }, transaction);
  return row || null;
}

async function findContractForSale(contractId, transaction) {
  const [row] = await run('SELECT id, contract_type, opportunity_id, total_value, status FROM legal.contracts WHERE id = :contractId AND deleted_at IS NULL', { contractId }, transaction);
  return row || null;
}

module.exports = {
  insertEvent, listTouches, findFirstRoleTouch, addRole, findOpportunity, setOpportunitySource, findLinkActiveAt, campaignExists, findMessage,
  findContractForSale,
};
