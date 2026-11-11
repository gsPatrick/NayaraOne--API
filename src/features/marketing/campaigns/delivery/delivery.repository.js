'use strict';

const { run } = require('../campaigns.repository');
const { OPEN_STATUSES } = require('./delivery.constants');

/** SQL de marketing.campaign_step_deliveries (uma linha por step e destinatário; UPDATE só de linha aberta ou FAILED, pelo gatilho da migration 757). */

const COLS = 'id, campaign_id, step_id, person_id, action_key, status, reason, external_ref, attempts, rate_deferrals, reconcile_attempts, next_attempt_at';

/**
 * Destinatários a processar agora no step: quem ainda não tem entrega e quem tem entrega ABERTA (RETRY/UNKNOWN) com a hora de voltar vencida. `delivery` vem
 * junto (null para quem é novo). Ordem estável por pessoa.
 */
async function dueRecipients(campaignId, stepId, tenant, now, limit, transaction) {
  const rows = await run(
    `SELECT m.person_id, d.id AS d_id, d.status AS d_status, d.reason AS d_reason, d.attempts AS d_attempts, d.rate_deferrals AS d_rate_deferrals,
            d.reconcile_attempts AS d_reconcile_attempts, d.next_attempt_at AS d_next_attempt_at
       FROM (SELECT DISTINCT person_id FROM marketing.campaign_audience_members WHERE campaign_id = :campaignId AND company_id = :companyId) m
       LEFT JOIN marketing.campaign_step_deliveries d ON d.step_id = :stepId AND d.person_id = m.person_id AND d.company_id = :companyId
      WHERE d.id IS NULL OR (d.status IN (:open) AND d.next_attempt_at <= :now)
      ORDER BY m.person_id LIMIT :limit`,
    { campaignId, stepId, companyId: tenant.companyId, now, limit, open: OPEN_STATUSES }, transaction
  );
  return rows.map((r) => ({
    personId: r.person_id,
    delivery: r.d_id ? { id: r.d_id, status: r.d_status, reason: r.d_reason, attempts: r.d_attempts, rate_deferrals: r.d_rate_deferrals, reconcile_attempts: r.d_reconcile_attempts, next_attempt_at: r.d_next_attempt_at } : null,
  }));
}

/** O step terminou? Ninguém do público sem entrega e nenhuma entrega aberta (RETRY/UNKNOWN), vencida ou não. */
async function stepComplete(campaignId, stepId, tenant, transaction) {
  const [row] = await run(
    `SELECT (EXISTS (SELECT 1 FROM marketing.campaign_audience_members m WHERE m.campaign_id = :campaignId AND m.company_id = :companyId
               AND NOT EXISTS (SELECT 1 FROM marketing.campaign_step_deliveries d WHERE d.step_id = :stepId AND d.person_id = m.person_id))
         OR EXISTS (SELECT 1 FROM marketing.campaign_step_deliveries d WHERE d.step_id = :stepId AND d.company_id = :companyId AND d.status IN (:open))) AS pending`,
    { campaignId, stepId, companyId: tenant.companyId, open: OPEN_STATUSES }, transaction
  );
  return !row.pending;
}

/** Primeira gravação da entrega (idempotente pela action_key: quem perdeu a corrida não grava de novo). */
const insertDelivery = (tenant, d, transaction) => run(
  `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status, reason, external_ref, attempts, rate_deferrals, reconcile_attempts, next_attempt_at)
   VALUES (:groupId, :companyId, :campaignId, :stepId, :personId, :actionKey, :status, :reason, :externalRef, :attempts, :rateDeferrals, :reconcileAttempts, :nextAttemptAt)
   ON CONFLICT (company_id, action_key) DO NOTHING RETURNING id`,
  {
    groupId: tenant.groupId, companyId: tenant.companyId, campaignId: d.campaignId, stepId: d.stepId, personId: d.personId, actionKey: d.actionKey, status: d.status,
    reason: d.reason || null, externalRef: d.externalRef || null, attempts: d.attempts ?? 1, rateDeferrals: d.rateDeferrals ?? 0, reconcileAttempts: d.reconcileAttempts ?? 0, nextAttemptAt: d.nextAttemptAt || null,
  }, transaction
);

/** Muda uma entrega existente (aberta ou FAILED). Os contadores omitidos ficam como estão. */
const updateDelivery = (id, tenant, d, transaction) => run(
  `UPDATE marketing.campaign_step_deliveries SET status = :status, reason = :reason, external_ref = COALESCE(:externalRef, external_ref),
          attempts = COALESCE(:attempts, attempts), rate_deferrals = COALESCE(:rateDeferrals, rate_deferrals), reconcile_attempts = COALESCE(:reconcileAttempts, reconcile_attempts),
          next_attempt_at = :nextAttemptAt, processed_at = now()
    WHERE id = :id AND company_id = :companyId RETURNING id`,
  {
    id, companyId: tenant.companyId, status: d.status, reason: d.reason || null, externalRef: d.externalRef || null, attempts: d.attempts ?? null, rateDeferrals: d.rateDeferrals ?? null,
    reconcileAttempts: d.reconcileAttempts ?? null, nextAttemptAt: d.nextAttemptAt || null,
  }, transaction
);

/** Grava a entrega: insere quando é a primeira vez, atualiza quando já existe. */
const saveDelivery = (tenant, base, existing, d, transaction) => (existing ? updateDelivery(existing.id, tenant, d, transaction) : insertDelivery(tenant, { ...base, ...d }, transaction));

/** Entregas ABERTAS (com travamento) de steps que não estão mais SCHEDULED: a campanha encerrou ou o step foi pulado. `stepIds` opcional. */
const openOfClosedSteps = (tenant, { campaignId = null, stepIds = null, status = null, dueBy = null, limit = 500 }, transaction) => run(
  `SELECT d.${COLS.split(', ').join(', d.')}, s.status AS step_status, s.status_reason AS step_reason, s.step_no, s.channel, s.template_id, s.content_item_id, c.code AS campaign_code, c.channels
     FROM marketing.campaign_step_deliveries d
     JOIN marketing.campaign_steps s ON s.id = d.step_id AND s.company_id = d.company_id
     JOIN marketing.campaigns c ON c.id = d.campaign_id AND c.company_id = d.company_id
    WHERE d.company_id = :companyId AND d.status IN (:statuses) AND (s.status <> 'SCHEDULED' OR c.status = 'ENDED')
      AND (CAST(:campaignId AS uuid) IS NULL OR d.campaign_id = CAST(:campaignId AS uuid))
      AND (:noSteps OR d.step_id IN (:stepIds))
      AND (CAST(:dueBy AS timestamptz) IS NULL OR d.next_attempt_at <= CAST(:dueBy AS timestamptz))
    ORDER BY d.next_attempt_at, d.id LIMIT :limit FOR UPDATE OF d SKIP LOCKED`,
  {
    companyId: tenant.companyId, statuses: status ? [status] : OPEN_STATUSES, campaignId, noSteps: !stepIds || stepIds.length === 0,
    stepIds: stepIds && stepIds.length ? stepIds : ['00000000-0000-0000-0000-000000000000'], dueBy, limit,
  }, transaction
);

/** Contagem por status e, nos FAILED/abertos, por motivo; a próxima volta agendada. Para a consulta da campanha (GET /marketing/campaigns/:id). */
const summaryRows = (campaignId, tenant, transaction) => run(
  `SELECT status, reason, count(*)::int AS n, min(next_attempt_at) AS next_at FROM marketing.campaign_step_deliveries
    WHERE campaign_id = :campaignId AND company_id = :companyId GROUP BY status, reason ORDER BY status, reason`,
  { campaignId, companyId: tenant.companyId }, transaction
);

module.exports = { dueRecipients, stepComplete, insertDelivery, updateDelivery, saveDelivery, openOfClosedSteps, summaryRows, COLS };
