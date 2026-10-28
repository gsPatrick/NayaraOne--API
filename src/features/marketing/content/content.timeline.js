'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { contentNotFound } = require('./pipeline.errors');
const { isUuid } = require('./content.input');

/** GET /marketing/content/:id (I1) — linha do tempo: item, versões, checks_json de cada passo, findings da validação e jobs. */
async function getContent(tenant, itemId, transaction) {
  if (!isUuid(itemId)) throw contentNotFound();
  const run = (sql, replacements) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  const [item] = await run(
    `SELECT id, type, title, status, source_entity_type, source_entity_id, source_version, current_version_id, campaign_id, updates_content_item_id,
            created_by, created_at, updated_at FROM marketing.content_items WHERE id = :itemId AND company_id = :companyId AND deleted_at IS NULL`,
    { itemId, companyId: tenant.companyId }
  );
  if (!item) throw contentNotFound();
  const versions = await run(
    `SELECT id, version_no, body_json, facts_hash, template_id, template_version_no, model_name, nay_run_id, checks_json, content_hash,
            approved_by, approved_at, approved_hash, created_at
       FROM marketing.content_versions WHERE content_item_id = :itemId AND company_id = :companyId ORDER BY version_no`,
    { itemId, companyId: tenant.companyId }
  );
  const current = versions.find((v) => v.id === item.current_version_id) || versions[versions.length - 1] || null;
  const jobs = current
    ? await run('SELECT id, channel, status, scheduled_at, attempts, last_error_code FROM marketing.publication_jobs WHERE content_version_id = :v AND deleted_at IS NULL ORDER BY channel', { v: current.id })
    : [];
  const checks = current ? current.checks_json : {};
  const factual = checks.factual && checks.factual.detalhes ? checks.factual.detalhes : {};
  return {
    id: item.id, type: item.type, title: item.title, status: item.status,
    source: item.source_entity_type ? { type: item.source_entity_type, id: item.source_entity_id, version: item.source_version } : null,
    campaignId: item.campaign_id, updatesContentItemId: item.updates_content_item_id, createdBy: item.created_by, createdAt: item.created_at, updatedAt: item.updated_at,
    currentVersion: current ? versionDto(current) : null,
    checks,
    findings: factual.findings || [],
    versions: versions.map((v) => ({ id: v.id, versionNo: v.version_no, contentHash: v.content_hash, templateId: v.template_id, createdAt: v.created_at })),
    jobs: jobs.map((j) => ({ id: j.id, channel: j.channel, status: j.status, scheduledAt: j.scheduled_at, attempts: j.attempts, lastErrorCode: j.last_error_code })),
  };
}

function versionDto(v) {
  return {
    id: v.id, versionNo: v.version_no, body: v.body_json, contentHash: v.content_hash, factsHash: v.facts_hash, templateId: v.template_id,
    templateVersionNo: v.template_version_no, modelName: v.model_name, nayRunId: v.nay_run_id, approvedBy: v.approved_by, approvedAt: v.approved_at,
    approvedHash: v.approved_hash,
  };
}

module.exports = { getContent };
