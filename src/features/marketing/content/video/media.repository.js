'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** SQL da autorização de mídia e dos derivados (M9-D426). RLS por grupo e empresa vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const AUTH_COLUMNS = 'id, file_id, sha256, origin, authorized_by, authorized_at, revoked_at, revoked_by';
const DERIV_COLUMNS = `id, inputs_hash, derived_file_id, derived_sha256, derived_from, transform_log, format, aspect_ratio, duration_s,
  synthetic, synthetic_kinds, created_by, created_at`;

const findAuthorization = async (fileId, transaction) => (await run(`SELECT ${AUTH_COLUMNS} FROM marketing.media_authorizations WHERE file_id = :fileId`, { fileId }, transaction))[0] || null;

/** Trava a linha da autorização do arquivo (revogar e usar não se cruzam). */
const lockAuthorization = async (fileId, transaction) => (await run(`SELECT ${AUTH_COLUMNS} FROM marketing.media_authorizations WHERE file_id = :fileId FOR UPDATE`, { fileId }, transaction))[0] || null;

/** Autoriza (ou reautoriza, depois de revogada) o arquivo: uma linha por arquivo. */
async function upsertAuthorization(tenant, { fileId, sha256, origin, actor }, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.media_authorizations (group_id, company_id, file_id, sha256, origin, authorized_by)
     VALUES (:groupId, :companyId, :fileId, :sha256, :origin, :actor)
     ON CONFLICT (company_id, file_id) DO UPDATE SET sha256 = EXCLUDED.sha256, origin = EXCLUDED.origin, authorized_by = EXCLUDED.authorized_by,
        authorized_at = now(), revoked_at = NULL, revoked_by = NULL, updated_at = now()
     RETURNING ${AUTH_COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, fileId, sha256, origin, actor }, transaction
  );
  return row;
}

async function markRevoked(fileId, actor, transaction) {
  const [row] = await run(`UPDATE marketing.media_authorizations SET revoked_at = now(), revoked_by = :actor, updated_at = now() WHERE file_id = :fileId AND revoked_at IS NULL RETURNING ${AUTH_COLUMNS}`, { fileId, actor }, transaction);
  return row || null;
}

const findDerivative = async (id, transaction) => (await run(`SELECT ${DERIV_COLUMNS} FROM marketing.media_derivatives WHERE id = :id`, { id }, transaction))[0] || null;
const findDerivativeByInputs = async (inputsHash, transaction) => (await run(`SELECT ${DERIV_COLUMNS} FROM marketing.media_derivatives WHERE inputs_hash = :inputsHash`, { inputsHash }, transaction))[0] || null;
const findDerivativeByFile = async (fileId, transaction) => (await run(`SELECT ${DERIV_COLUMNS} FROM marketing.media_derivatives WHERE derived_file_id = :fileId`, { fileId }, transaction))[0] || null;

async function insertDerivative(tenant, values, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.media_derivatives (group_id, company_id, inputs_hash, derived_file_id, derived_sha256, derived_from, transform_log, format, aspect_ratio,
        duration_s, synthetic, synthetic_kinds, created_by)
     VALUES (:groupId, :companyId, :inputsHash, :derivedFileId, :derivedSha256, CAST(:derivedFrom AS jsonb), CAST(:transformLog AS jsonb), :format, :aspectRatio,
        :durationS, :synthetic, CAST(:kinds AS jsonb), :actor)
     RETURNING ${DERIV_COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, inputsHash: values.inputsHash, derivedFileId: values.derivedFileId, derivedSha256: values.derivedSha256,
      derivedFrom: JSON.stringify(values.derivedFrom), transformLog: JSON.stringify(values.transformLog), format: values.format, aspectRatio: values.aspectRatio || null,
      durationS: values.durationS === undefined ? null : values.durationS, synthetic: Boolean(values.synthetic), kinds: JSON.stringify(values.syntheticKinds || []), actor: values.actor || null,
    }, transaction
  );
  return row;
}


module.exports = { findAuthorization, lockAuthorization, upsertAuthorization, markRevoked, findDerivative, findDerivativeByInputs, findDerivativeByFile, insertDerivative };
