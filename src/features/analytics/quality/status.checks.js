'use strict';

/**
 * M9-D697 (3.1) — qualidade vinda dos checks: a ÚLTIMA execução de cada check ao vivo (eventos e agenda; a execução sobre a sombra do rebuild não
 * conta) que afeta a métrica. Execução BLOCK que falhou, ou check em ERROR, deixa a métrica DEGRADED; a execução seguinte que passa supera a falha
 * (recuperação automática). A razão sai só com código e tipo do check, nunca com o valor observado (dado restrito).
 *
 * Leitura (correção de 16/11/2026): a última execução ao vivo de CADA check da empresa é lida de uma vez, pelo índice
 * data_quality_checks_latest_idx (company_id, read_model, check_code, executed_at DESC, created_at DESC; migration 20261116210000), e a métrica
 * olha as que a listam em affected_metric_codes. Antes, cada métrica filtrava o histórico inteiro por `affected_metric_codes @> ARRAY[...]`, que
 * sob RLS não usa índice (operador não leakproof): na homologação, 510 mil linhas (~1 s) por métrica, dezenas de vezes por GET do Centro de Comando.
 * Agora: os pares (read_model, check_code) saem por salto no índice e, de cada par, só a linha mais nova ao vivo; tudo com igualdade e comparação
 * de texto (leakproof). Num GET de BI o resultado é memorizado na requisição (requestMemo), então a empresa é lida uma vez por GET.
 * A lista de métricas de um check vem do catálogo (check.metrics, quality.execute.js). Vale a da execução mais nova: se o catálogo deixar de ligar
 * um check a uma métrica, uma falha antiga desse check deixa de degradá-la (antes, a última execução que ainda a listava continuava valendo).
 */
const { sequelize } = require('../../../models');
const { isBlocking } = require('./quality.severity');
const { memoInReadOnly } = require('../readOnly/requestMemo');

const LATEST_RUNS_SQL = `
  WITH RECURSIVE pares AS (
    (SELECT q.read_model, q.check_code FROM analytics.data_quality_checks q WHERE q.company_id = :companyId ORDER BY q.read_model, q.check_code LIMIT 1)
    UNION ALL
    SELECT n.read_model, n.check_code FROM pares p CROSS JOIN LATERAL (
      (SELECT q.read_model, q.check_code FROM analytics.data_quality_checks q
        WHERE q.company_id = :companyId AND q.read_model = p.read_model AND q.check_code > p.check_code ORDER BY q.read_model, q.check_code LIMIT 1)
      UNION ALL
      (SELECT q.read_model, q.check_code FROM analytics.data_quality_checks q
        WHERE q.company_id = :companyId AND q.read_model > p.read_model ORDER BY q.read_model, q.check_code LIMIT 1)
      LIMIT 1) n
  )
  SELECT p.read_model AS "readModel", p.check_code AS "checkCode", x.check_type AS "checkType", x.status, x.severity,
         x.affected_metric_codes AS "affectedMetricCodes"
    FROM pares p CROSS JOIN LATERAL (
      SELECT q.check_type, q.status, q.severity, q.affected_metric_codes
        FROM analytics.data_quality_checks q LEFT JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
       WHERE q.company_id = :companyId AND q.read_model = p.read_model AND q.check_code = p.check_code AND (r.id IS NULL OR r."trigger" <> 'REBUILD')
       ORDER BY q.executed_at DESC, q.created_at DESC LIMIT 1) x
   ORDER BY p.read_model, p.check_code`;

/** Última execução ao vivo de cada check da empresa (uma por read_model + check_code), em ordem de read_model e check_code. */
function latestRunsOfCompany(companyId, transaction) {
  return memoInReadOnly(transaction, `quality_latest_runs:${companyId}`, async () => {
    const [rows] = await sequelize.query(LATEST_RUNS_SQL, { replacements: { companyId }, transaction });
    return rows;
  });
}

async function lastRuns(metricCode, companyId, transaction) {
  const runs = await latestRunsOfCompany(companyId, transaction);
  return runs
    .filter((r) => Array.isArray(r.affectedMetricCodes) && r.affectedMetricCodes.includes(metricCode))
    .map(({ readModel, checkCode, checkType, status, severity }) => ({ readModel, checkCode, checkType, status, severity }));
}

const degrades = (r) => r.status === 'ERROR' || (r.status === 'FAILED' && isBlocking(r.severity));

/** { status: 'OK' | 'DEGRADED', degradedBy: [{ readModel, checkCode, checkType, status, severity }] }. */
async function checkQuality(metricCode, scope, transaction) {
  const bad = (await lastRuns(metricCode, scope.companyId, transaction)).filter(degrades);
  return { status: bad.length ? 'DEGRADED' : 'OK', degradedBy: bad };
}

module.exports = { checkQuality, degrades, LATEST_RUNS_SQL };
