'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL do pipeline de conteúdo (M9-D406). RLS por grupo e empresa vale na transação do chamador; nunca lê tabela de origem. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const ITEM_COLUMNS = `id, company_id, type, title, status, source_entity_type, source_entity_id, source_version, current_version_id,
  nay_run_id, autopublish_class, campaign_id, created_by`;
const VERSION_COLUMNS = `id, content_item_id, version_no, body_json, facts_snapshot_json, facts_hash, template_id, template_version_no,
  model_name, nay_run_id, checks_json, content_hash, approved_by, approved_at, approved_hash`;

/** Trava o item (FOR UPDATE, sem JOIN): duas execuções do mesmo passo se enfileiram aqui. */
async function lockItem(itemId, transaction) {
  const [row] = await run(`SELECT ${ITEM_COLUMNS} FROM marketing.content_items WHERE id = :itemId AND deleted_at IS NULL FOR UPDATE`, { itemId }, transaction);
  return row || null;
}

async function findVersion(versionId, transaction) {
  const [row] = await run(`SELECT ${VERSION_COLUMNS} FROM marketing.content_versions WHERE id = :versionId AND deleted_at IS NULL`, { versionId }, transaction);
  return row || null;
}

async function latestVersionNo(itemId, transaction) {
  const [row] = await run('SELECT COALESCE(max(version_no), 0)::int AS n FROM marketing.content_versions WHERE content_item_id = :itemId', { itemId }, transaction);
  return row.n;
}

/** Nova versão do item (o corpo de uma versão é imutável): copia fatos e checks da anterior e vira a versão corrente. */
async function insertNextVersion(tenant, actor, previous, values, transaction) {
  const versionNo = (await latestVersionNo(previous.content_item_id, transaction)) + 1;
  const [row] = await run(
    `INSERT INTO marketing.content_versions (id, group_id, company_id, content_item_id, version_no, body_json, facts_snapshot_json, facts_hash,
        template_id, template_version_no, model_name, nay_run_id, checks_json, content_hash, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :itemId, :versionNo, CAST(:body AS jsonb), CAST(:facts AS jsonb), :factsHash,
        :templateId, :templateVersionNo, :modelName, :nayRunId, CAST(:checks AS jsonb), :contentHash, :actor, :actor)
     RETURNING ${VERSION_COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, itemId: previous.content_item_id, versionNo,
      body: JSON.stringify(values.body), facts: JSON.stringify(values.facts === undefined ? previous.facts_snapshot_json : values.facts),
      factsHash: values.factsHash === undefined ? previous.facts_hash : values.factsHash,
      templateId: values.templateId === undefined ? previous.template_id : values.templateId,
      templateVersionNo: values.templateVersionNo === undefined ? previous.template_version_no : values.templateVersionNo,
      modelName: values.modelName === undefined ? previous.model_name : values.modelName,
      nayRunId: values.nayRunId === undefined ? previous.nay_run_id : values.nayRunId,
      checks: JSON.stringify(values.checks === undefined ? previous.checks_json : values.checks),
      contentHash: values.contentHash, actor: actor || null,
    },
    transaction
  );
  await run('UPDATE marketing.content_items SET current_version_id = :versionId, updated_by = :actor, updated_at = now() WHERE id = :itemId RETURNING id',
    { versionId: row.id, itemId: previous.content_item_id, actor: actor || null }, transaction);
  return row;
}

/** Atualiza a versão da fonte carimbada no item (nova geração com os fatos de agora). */
async function setSource(itemId, sourceVersion, actor, transaction) {
  await run('UPDATE marketing.content_items SET source_version = :sourceVersion, updated_by = :actor, updated_at = now() WHERE id = :itemId RETURNING id',
    { itemId, sourceVersion, actor: actor || null }, transaction);
}

async function setStatus(itemId, status, actor, transaction) {
  await run('UPDATE marketing.content_items SET status = :status, updated_by = :actor, updated_at = now() WHERE id = :itemId RETURNING id',
    { itemId, status, actor: actor || null }, transaction);
}

/** Grava checks_json[step] da versão (checks_json é o campo da versão que continua gravável). */
async function writeCheck(versionId, step, check, actor, transaction) {
  await run(
    `UPDATE marketing.content_versions SET checks_json = jsonb_set(checks_json, ARRAY[:step], CAST(:check AS jsonb), true),
        updated_by = :actor, updated_at = now() WHERE id = :versionId RETURNING id`,
    { versionId, step, check: JSON.stringify(check), actor: actor || null }, transaction
  );
}

async function setApprover(versionId, approvedBy, actor, transaction) {
  await run('UPDATE marketing.content_versions SET approved_by = :approvedBy, approved_at = now(), updated_by = :actor, updated_at = now() WHERE id = :versionId RETURNING id',
    { versionId, approvedBy, actor: actor || null }, transaction);
}

/** Template PUBLISHED (o mais novo do código) ou, com anyStatus, o id exato mesmo aposentado (conteúdo que já o usava). */
async function findPublishedTemplate({ templateId, code, anyStatus = false }, transaction) {
  const where = templateId ? 'id = :key' : 'code = :key';
  const [row] = await run(
    `SELECT id, code, version_no, kind, channel, status, body, variables_json, brand_tokens_json, content_hash FROM marketing.templates
      WHERE ${where} ${anyStatus ? '' : "AND status = 'PUBLISHED'"} AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1`,
    { key: templateId || code }, transaction
  );
  return row || null;
}

/** Cria o job da publicação; a chave de idempotência já existente devolve o job gravado (replay). */
async function insertJob(tenant, actor, values, transaction) {
  const [created] = await run(
    `INSERT INTO marketing.publication_jobs (id, group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key,
        scheduled_at, next_attempt_at, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :versionId, :channel, :adapter, 'PENDING', :key, :scheduledAt, :scheduledAt, :actor, :actor)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id, channel, scheduled_at, status`,
    { groupId: tenant.groupId, companyId: tenant.companyId, versionId: values.versionId, channel: values.channel, adapter: values.adapterCode,
      key: values.idempotencyKey, scheduledAt: values.scheduledAt, actor: actor || null }, transaction
  );
  if (created) return { ...created, replay: false };
  const [existing] = await run('SELECT id, channel, scheduled_at, status FROM marketing.publication_jobs WHERE company_id = :companyId AND idempotency_key = :key',
    { companyId: tenant.companyId, key: values.idempotencyKey }, transaction);
  return { ...existing, replay: true };
}

async function listJobs(versionId, transaction) {
  return run('SELECT id, channel, status, scheduled_at, idempotency_key FROM marketing.publication_jobs WHERE content_version_id = :versionId AND deleted_at IS NULL ORDER BY channel',
    { versionId }, transaction);
}

module.exports = {
  lockItem, findVersion, insertNextVersion, setSource, setStatus, writeCheck, setApprover, findPublishedTemplate, insertJob, listJobs,
};
