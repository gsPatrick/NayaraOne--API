'use strict';

/**
 * M9-D609 (3.3 e 6) — diário do snapshot diário (analytics.snapshot_job_runs): uma linha por (empresa, data-base). `claimDay` reivindica o dia
 * pela unicidade: dois jobs simultâneos disputam a linha e o segundo ignora (recebe null). Uma linha RUNNING abandonada (job que caiu) pode ser
 * retomada depois de `staleAfterMinutes`; PARTIAL é retomada na passada seguinte. Escrita só com a GUC do worker de BI.
 */
const { sequelize } = require('../../../models');
const { assertWriter } = require('../metricStore.service');

const STALE_AFTER_MINUTES = 60;

/** Linhas da janela (empresa vem da RLS): [{ as_of_date, status }]. */
async function listRuns({ fromDate, toDate }, transaction) {
  const [rows] = await sequelize.query(
    'SELECT as_of_date::text AS as_of_date, status FROM analytics.snapshot_job_runs WHERE as_of_date BETWEEN :fromDate AND :toDate ORDER BY as_of_date',
    { replacements: { fromDate, toDate }, transaction }
  );
  return rows;
}

/** Reivindica o dia; devolve a linha ou null se outro job já o detém (ou já está COMPLETED). */
async function claimDay({ companyId, groupId, asOfDate, capturedLate, now }, transaction) {
  await assertWriter(transaction);
  const [rows] = await sequelize.query(
    `INSERT INTO analytics.snapshot_job_runs (company_id, group_id, as_of_date, status, captured_late, started_at)
     VALUES (:companyId, :groupId, :asOfDate, 'RUNNING', :capturedLate, :now)
     ON CONFLICT (company_id, as_of_date) DO UPDATE
        SET status = 'RUNNING', captured_late = EXCLUDED.captured_late, started_at = EXCLUDED.started_at, finished_at = NULL, updated_at = now()
      WHERE analytics.snapshot_job_runs.status = 'PARTIAL'
         OR (analytics.snapshot_job_runs.status = 'RUNNING' AND analytics.snapshot_job_runs.started_at < CAST(:now AS timestamptz) - make_interval(mins => :staleAfter))
     RETURNING *`,
    { replacements: { companyId, groupId, asOfDate, capturedLate, now, staleAfter: STALE_AFTER_MINUTES }, transaction }
  );
  return rows[0] || null;
}

/** Fecha o dia: COMPLETED se nenhuma métrica falhou; senão PARTIAL (refeito na passada seguinte, só o que falta). */
async function finishDay(id, counts, now, transaction) {
  await assertWriter(transaction);
  const [[row]] = await sequelize.query(
    `UPDATE analytics.snapshot_job_runs
        SET status = CASE WHEN :failed = 0 THEN 'COMPLETED' ELSE 'PARTIAL' END, finished_at = :now, metrics_total = :total,
            snapshots_written = :written, snapshots_existing = :existing, metrics_without_provider = :noProvider,
            metrics_without_source = :noSource, metrics_failed = :failed, updated_at = now()
      WHERE id = :id RETURNING *`,
    {
      replacements: {
        id, now, total: counts.total, written: counts.written, existing: counts.existing, noProvider: counts.withoutProvider,
        noSource: counts.withoutSource, failed: counts.failed,
      },
      transaction,
    }
  );
  return row;
}

module.exports = { listRuns, claimDay, finishDay, STALE_AFTER_MINUTES };
