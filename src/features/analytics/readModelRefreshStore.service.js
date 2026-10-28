'use strict';

/**
 * M9-D602 — diário das atualizações dos read models (analytics.read_model_refreshes).
 * Uma linha por lote de eventos, por execução agendada ou por rebuild, nunca uma por evento (M9-D607).
 * Escrita só do worker de BI (GUC de escrita).
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { invalid, requireOneOf, assertWriter } = require('./analyticsStoreSupport');
const { runAlert } = require('./alertErrors');

const CODE = 'ANALYTICS_REFRESH_INVALID';
const TRIGGERS = ['EVENT', 'SCHEDULE', 'REBUILD'];
const FINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'DEGRADED'];
const MODEL_RE = /^[a-z][a-z0-9_]*$/;

/** Abre o registro do refresh em RUNNING. */
async function startRefresh(input, ctx, transaction) {
  await assertWriter(transaction);
  if (typeof input.readModel !== 'string' || !MODEL_RE.test(input.readModel)) throw invalid(CODE, 'O read model deve usar minúsculas, números e "_".');
  requireOneOf(input.trigger, TRIGGERS, 'Gatilho do refresh', CODE);
  if (!input.groupId) throw invalid(CODE, 'Informe o grupo.');
  if (input.version != null && !(Number.isInteger(input.version) && input.version >= 1)) throw invalid(CODE, 'A versão deve ser um inteiro a partir de 1.');
  return runAlert(async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.read_model_refreshes (company_id, group_id, read_model, "trigger", version, source_snapshot_at)
       VALUES (:companyId, :groupId, :readModel, :trigger, COALESCE(:version, 1), :sourceSnapshotAt)
       RETURNING *`,
      {
        replacements: {
          companyId: input.companyId || null, groupId: input.groupId, readModel: input.readModel, trigger: input.trigger,
          version: input.version ?? null, sourceSnapshotAt: input.sourceSnapshotAt || null,
        },
        transaction,
      }
    );
    return row;
  });
}

/** Fecha o registro: status final, linhas gravadas, último evento de origem, erro (FAILED) e duração calculada. */
async function finishRefresh(id, patch, ctx, transaction) {
  await assertWriter(transaction);
  requireOneOf(patch?.status, FINAL_STATUSES, 'Status final do refresh', CODE);
  if (patch.status === 'FAILED' && !patch.errorCode) throw invalid(CODE, 'Refresh com falha exige o código do erro (errorCode).');
  if (patch.rowsUpserted != null && !(Number.isInteger(patch.rowsUpserted) && patch.rowsUpserted >= 0)) {
    throw invalid(CODE, 'rowsUpserted deve ser um inteiro a partir de 0.');
  }
  return runAlert(async () => {
    const [rows] = await sequelize.query('SELECT status FROM analytics.read_model_refreshes WHERE id = :id FOR UPDATE', { replacements: { id }, transaction });
    if (!rows[0]) throw AppError.notFound('Refresh não encontrado.', 'ANALYTICS_REFRESH_NOT_FOUND');
    if (rows[0].status !== 'RUNNING') throw AppError.conflict('Este refresh já foi encerrado.', 'ANALYTICS_REFRESH_ALREADY_FINISHED');
    const [[row]] = await sequelize.query(
      `UPDATE analytics.read_model_refreshes
          SET status = :status, finished_at = clock_timestamp(),
              duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::integer),
              rows_upserted = COALESCE(:rowsUpserted, rows_upserted), last_source_event_id = COALESCE(:lastEvent, last_source_event_id),
              source_snapshot_at = COALESCE(:snapshotAt, source_snapshot_at), error_code = :errorCode, error_message = :errorMessage, updated_at = now()
        WHERE id = :id RETURNING *`,
      {
        replacements: {
          id, status: patch.status, rowsUpserted: patch.rowsUpserted ?? null, lastEvent: patch.lastSourceEventId ?? null,
          snapshotAt: patch.sourceSnapshotAt || null, errorCode: patch.errorCode || null,
          errorMessage: patch.errorMessage ? String(patch.errorMessage).slice(0, 2000) : null,
        },
        transaction,
      }
    );
    return row;
  });
}

module.exports = { startRefresh, finishRefresh, TRIGGERS };
