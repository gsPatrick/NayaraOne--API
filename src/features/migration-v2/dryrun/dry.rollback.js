'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const canary = require('../canary/canary.service');
const params = require('../canary/canary.params');
const { SECTOR_CODES } = require('../canary/canary.constants');
const reportService = require('../rollback/report.service');

const pendingItems = async (tenant, sectors, transaction) => (await sequelize.query(
  "SELECT count(*)::int AS n FROM governance.rollback_items WHERE company_id = :companyId AND state = 'PENDING_COMPENSATION' AND sector IN (:sectors)",
  { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, sectors } }
))[0].n;

/**
 * Ativação por setor e simulação de rollback no ensaio (M9-D908 §3.3.2, D904 e D907): cada setor avança até a primeira etapa (as travas da Torre e da comparação valem como no corte)
 * e volta a 0 pelo rollback de setor, que dispara o gancho da D907. A simulação só conta como concluída quando todo setor avançou e voltou a 0 e não sobrou item de compensação
 * pendente. Devolve { sectors[], activated, rolledBack, pendingItems, complete, report }.
 */
async function simulateRollback(tenant, actor) {
  const sectorTenant = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actor.userId || null };
  const stages = await openTenantTx(tenant, (transaction) => params.readStages(tenant, transaction));
  const sectors = [];
  for (const sector of SECTOR_CODES) {
    const row = { sector, advanced: false, rolledBack: false, error: null };
    try {
       
      const up = await openTenantTx(tenant, (transaction) => canary.advance(sectorTenant, sector, { percent: stages[0] }, transaction));
      row.advanced = up.percent === stages[0];
       
      const down = await openTenantTx(tenant, (transaction) => canary.rollback(sectorTenant, sector, { reason: 'Simulação de rollback do ensaio DRY3.' }, transaction));
      row.rolledBack = down.percent === 0;
    } catch (err) {
      row.error = { code: err.code || 'ERROR', message: String(err.message || err).slice(0, 200) };
      if (row.advanced && !row.rolledBack) {
        // o setor subiu e o rollback falhou: tenta de novo, para o ensaio não deixar o setor ligado
         
        await openTenantTx(tenant, (transaction) => canary.rollback(sectorTenant, sector, { reason: 'Simulação de rollback do ensaio DRY3 (nova tentativa).' }, transaction)).then((down) => { row.rolledBack = down.percent === 0; }).catch(() => {});
      }
    }
    sectors.push(row);
  }
  const pending = await openTenantTx(tenant, (transaction) => pendingItems(tenant, SECTOR_CODES, transaction));
  const report = await openTenantTx(tenant, (transaction) => reportService.getReport(tenant, {}, transaction));
  const complete = sectors.every((row) => row.advanced && row.rolledBack) && pending === 0;
  return { sectors, activated: sectors.filter((row) => row.advanced).length, rolledBack: sectors.filter((row) => row.rolledBack).length, pendingItems: pending, complete, t0: report.t0 };
}

module.exports = { simulateRollback };
