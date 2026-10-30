'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Situação de cada coletor da empresa: último sucesso, última falha e quantas falhas seguidas (falha mantém o último sucesso à vista). */
async function collectorStatus(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT collector, last_status, last_run_at, last_success_at, last_success_lines, last_failure_at, last_error_code, consecutive_failures
       FROM governance.cost_collector_runs WHERE company_id = :companyId AND collector NOT LIKE 'det\\_%' ORDER BY collector`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((r) => ({
    coletor: r.collector, situacao: r.last_status, ultimaExecucao: r.last_run_at, ultimoSucesso: r.last_success_at, linhasUltimoSucesso: r.last_success_lines,
    ultimaFalha: r.last_failure_at, codigoUltimaFalha: r.last_error_code, falhasSeguidas: r.consecutive_failures,
  }));
}

/** Situação de cada detector de desperdício (M9-D862): mesma tabela de execuções, nomes `det_*`. */
async function detectorStatus(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT collector, last_status, last_run_at, last_success_at, last_failure_at, last_error_code, consecutive_failures
       FROM governance.cost_collector_runs WHERE company_id = :companyId AND collector LIKE 'det\\_%' ORDER BY collector`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((r) => ({
    detector: r.collector.replace(/^det_/, ''), situacao: r.last_status, ultimaExecucao: r.last_run_at, ultimoSucesso: r.last_success_at,
    ultimaFalha: r.last_failure_at, codigoUltimaFalha: r.last_error_code, falhasSeguidas: r.consecutive_failures,
  }));
}

module.exports = { collectorStatus, detectorStatus };
