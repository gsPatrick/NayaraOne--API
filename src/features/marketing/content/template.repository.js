'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso SQL a marketing.templates (RLS por grupo e empresa vale na transação do chamador). Nunca lê tabela de origem. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLUMNS = `id, code, version_no, kind, channel, status, body, variables_json, brand_tokens_json, official_template_ref,
  content_hash, created_at, created_by`;

function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    versionNo: row.version_no,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    body: row.body,
    variables: row.variables_json,
    brandTokens: row.brand_tokens_json,
    officialTemplateRef: row.official_template_ref,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** Serializa criações e publicações do mesmo código na empresa (a trava vale até o fim da transação). */
async function lockCode(companyId, code, transaction) {
  await run('SELECT pg_advisory_xact_lock(hashtextextended(:key, 404))', { key: `mkt_template:${companyId}:${code}` }, transaction);
}

async function findById(id, transaction) {
  const [row] = await run(`SELECT ${COLUMNS} FROM marketing.templates WHERE id = :id AND deleted_at IS NULL`, { id }, transaction);
  return row || null;
}

/** Trava a linha (FOR UPDATE, sem JOIN) e devolve o estado mais recente. */
async function lockById(id, transaction) {
  const [row] = await run(`SELECT ${COLUMNS} FROM marketing.templates WHERE id = :id AND deleted_at IS NULL FOR UPDATE`, { id }, transaction);
  return row || null;
}

async function latestVersion(code, transaction) {
  const [row] = await run(
    `SELECT ${COLUMNS} FROM marketing.templates WHERE code = :code AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1`, { code }, transaction
  );
  return row || null;
}

/** Maior versão já publicada (PUBLISHED ou RETIRED) do código, para recusar a publicação de versão mais antiga. */
async function highestReleasedVersion(code, transaction) {
  const [row] = await run(
    `SELECT max(version_no)::int AS version_no FROM marketing.templates
      WHERE code = :code AND deleted_at IS NULL AND status IN ('PUBLISHED','RETIRED')`, { code }, transaction
  );
  return row ? row.version_no : null;
}

async function insertTemplate(values, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.templates (id, group_id, company_id, code, version_no, kind, channel, status, body, variables_json,
        brand_tokens_json, official_template_ref, content_hash, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :code, :versionNo, :kind, :channel, 'DRAFT', :body, CAST(:variables AS jsonb),
        CAST(:brandTokens AS jsonb), :officialTemplateRef, :contentHash, :actor, :actor)
     RETURNING ${COLUMNS}`,
    { ...values, variables: JSON.stringify(values.variables), brandTokens: JSON.stringify(values.brandTokens) },
    transaction
  );
  return row;
}

async function markPublished(id, actor, transaction) {
  const [row] = await run(
    `UPDATE marketing.templates SET status = 'PUBLISHED', updated_by = :actor, updated_at = now() WHERE id = :id RETURNING ${COLUMNS}`,
    { id, actor }, transaction
  );
  return row;
}

/** Aposenta (para uso novo) as demais versões PUBLISHED do código; devolve os version_no aposentados. */
async function retireOtherPublished(code, exceptId, actor, transaction) {
  const rows = await run(
    `UPDATE marketing.templates SET status = 'RETIRED', updated_by = :actor, updated_at = now()
      WHERE code = :code AND id <> :exceptId AND status = 'PUBLISHED' AND deleted_at IS NULL RETURNING version_no`,
    { code, exceptId, actor }, transaction
  );
  return rows.map((r) => r.version_no);
}

function buildFilter({ code, status, channel }) {
  const where = ['deleted_at IS NULL'];
  const replacements = {};
  if (code) { where.push('code = :code'); replacements.code = code; }
  if (status) { where.push('status = :status'); replacements.status = status; }
  if (channel) { where.push('channel = :channel'); replacements.channel = channel; }
  return { clause: where.join(' AND '), replacements };
}

async function countCodes(filters, transaction) {
  const { clause, replacements } = buildFilter(filters);
  const [row] = await run(`SELECT count(DISTINCT code)::int AS total FROM marketing.templates WHERE ${clause}`, replacements, transaction);
  return row.total;
}

async function pageOfCodes(filters, limit, offset, transaction) {
  const { clause, replacements } = buildFilter(filters);
  const rows = await run(
    `SELECT code FROM marketing.templates WHERE ${clause} GROUP BY code ORDER BY code ASC LIMIT :limit OFFSET :offset`,
    { ...replacements, limit, offset }, transaction
  );
  return rows.map((r) => r.code);
}

async function versionsOfCodes(codes, filters, transaction) {
  if (codes.length === 0) return [];
  const { clause, replacements } = buildFilter({ ...filters, code: null });
  return run(
    `SELECT ${COLUMNS} FROM marketing.templates WHERE ${clause} AND code IN (:codes) ORDER BY code ASC, version_no DESC`,
    { ...replacements, codes }, transaction
  );
}

async function publishedOfCodes(codes, transaction) {
  if (codes.length === 0) return [];
  return run(`SELECT ${COLUMNS} FROM marketing.templates WHERE code IN (:codes) AND status = 'PUBLISHED' AND deleted_at IS NULL`, { codes }, transaction);
}

module.exports = {
  toDto, lockCode, findById, lockById, latestVersion, highestReleasedVersion, insertTemplate, markPublished, retireOtherPublished,
  countCodes, pageOfCodes, versionsOfCodes, publishedOfCodes,
};
