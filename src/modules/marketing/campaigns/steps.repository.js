'use strict';

const { run } = require('./campaigns.repository');

/** SQL dos steps da campanha (campaign_steps). */
const listSteps = (campaignId, tenant, transaction) => run(
  'SELECT * FROM marketing.campaign_steps WHERE campaign_id = :campaignId AND company_id = :companyId AND deleted_at IS NULL ORDER BY step_no',
  { campaignId, companyId: tenant.companyId }, transaction
);

/**
 * Troca os steps do rascunho: upsert por (campaign_id, step_no) (revive linha excluída com o mesmo número) e exclusão lógica dos
 * números que sobraram. Steps de rascunho nascem PLANNED.
 */
async function replaceSteps(campaignId, steps, tenant, actor, transaction) {
  for (const s of steps) {
    await run(
      `INSERT INTO marketing.campaign_steps (id, group_id, company_id, campaign_id, step_no, channel, template_id, content_item_id, offset_minutes, status, created_by, updated_by)
       VALUES (gen_random_uuid(), :groupId, :companyId, :campaignId, :stepNo, :channel, :templateId, :contentItemId, :offsetMinutes, 'PLANNED', :actor, :actor)
       ON CONFLICT (campaign_id, step_no) DO UPDATE SET channel = EXCLUDED.channel, template_id = EXCLUDED.template_id, content_item_id = EXCLUDED.content_item_id,
         offset_minutes = EXCLUDED.offset_minutes, status = 'PLANNED', status_reason = NULL, deleted_at = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id`,
      { groupId: tenant.groupId, companyId: tenant.companyId, campaignId, ...s, actor: actor || null }, transaction
    );
  }
  await run(
    'UPDATE marketing.campaign_steps SET deleted_at = now(), updated_by = :actor WHERE campaign_id = :campaignId AND company_id = :companyId AND deleted_at IS NULL AND step_no > :last RETURNING id',
    { campaignId, companyId: tenant.companyId, last: steps.length, actor: actor || null }, transaction
  );
}

const templatesByIds = (ids, tenant, transaction) => run(
  'SELECT id, status, channel FROM marketing.templates WHERE id IN (:ids) AND company_id = :companyId AND deleted_at IS NULL', { ids, companyId: tenant.companyId }, transaction
);
const contentItemsByIds = (ids, tenant, transaction) => run(
  'SELECT id, status FROM marketing.content_items WHERE id IN (:ids) AND company_id = :companyId AND deleted_at IS NULL', { ids, companyId: tenant.companyId }, transaction
);

/** Ao agendar: todos os steps PLANNED viram SCHEDULED. */
async function scheduleSteps(campaignId, tenant, actor, transaction) {
  const rows = await run(
    `UPDATE marketing.campaign_steps SET status = 'SCHEDULED', updated_by = :actor, updated_at = now()
      WHERE campaign_id = :campaignId AND company_id = :companyId AND deleted_at IS NULL AND status = 'PLANNED' RETURNING id`,
    { campaignId, companyId: tenant.companyId, actor: actor || null }, transaction
  );
  return rows.length;
}

async function setStepStatus(stepId, status, reason, transaction) {
  await run('UPDATE marketing.campaign_steps SET status = :status, status_reason = :reason, updated_at = now() WHERE id = :stepId RETURNING id',
    { stepId, status, reason: reason || null }, transaction);
}

module.exports = { listSteps, replaceSteps, templatesByIds, contentItemsByIds, scheduleSteps, setStepStatus };
