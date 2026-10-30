'use strict';

const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const E = require('../finops.errors');

/**
 * Executa um coletor numa subtransação (savepoint): se falhar, NADA do que ele gravou fica (coleta transacional por lote), nenhum valor é inventado,
 * a falha é registrada em governance.cost_collector_runs (o último sucesso continua exibido) e o erro GOV_FINOPS_COLLECTOR_FAILED vai ao log (alerta).
 * Devolve { ok: true, lines } ou { ok: false, code, collector }; nunca lança, para um coletor não derrubar os outros nem a requisição que o chamou.
 */
async function runCollector(tenant, collector, work, transaction, now = new Date()) {
  try {
    const lines = await sequelize.transaction({ transaction }, (sp) => work(sp));
    await sequelize.query(
      `INSERT INTO governance.cost_collector_runs (group_id, company_id, collector, last_status, last_run_at, last_success_at, last_success_lines, consecutive_failures)
       VALUES (:groupId, :companyId, :collector, 'OK', :now, :now, :lines, 0)
       ON CONFLICT (company_id, collector) DO UPDATE SET last_status = 'OK', last_run_at = :now, last_success_at = :now, last_success_lines = :lines, consecutive_failures = 0, updated_at = CURRENT_TIMESTAMP`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, collector, now, lines: Number(lines) || 0 } }
    );
    return { ok: true, collector, lines: Number(lines) || 0 };
  } catch (err) {
    const failure = E.collectorFailed(collector, err);
    logger.error({ code: failure.code, collector, companyId: tenant.companyId, err: err.message }, 'finops.collector.failed');
    await sequelize.query(
      `INSERT INTO governance.cost_collector_runs (group_id, company_id, collector, last_status, last_run_at, last_failure_at, last_error_code, last_error_message, consecutive_failures)
       VALUES (:groupId, :companyId, :collector, 'FAILED', :now, :now, :code, :message, 1)
       ON CONFLICT (company_id, collector) DO UPDATE SET last_status = 'FAILED', last_run_at = :now, last_failure_at = :now, last_error_code = :code, last_error_message = :message,
         consecutive_failures = governance.cost_collector_runs.consecutive_failures + 1, updated_at = CURRENT_TIMESTAMP`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, collector, now, code: failure.code, message: String(err.message || err).slice(0, 500) } }
    );
    return { ok: false, collector, code: failure.code };
  }
}

module.exports = { runCollector };
