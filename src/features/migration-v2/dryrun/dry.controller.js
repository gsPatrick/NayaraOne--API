'use strict';

const { success } = require('../../../utils/httpResponse');
const logger = require('../../../utils/logger');
const service = require('./dry.service');
const { runDryRun } = require('./dry.orchestrator');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

/** POST /migration/dry-runs -> 202 { id }. O ensaio parte depois da resposta e o relatório mostra o andamento. */
async function start(req, res) {
  const tenant = tenantFromAuth(req);
  const actor = { userId: req.auth.userId };
  const report = await service.openDryRun(tenant, actor);
  setImmediate(() => runDryRun(tenant, actor, report.id).catch((err) => logger.error({ reportId: report.id, err: err.message }, 'migration.dry3.failed')));
  return success(res, { statusCode: 202, data: { id: report.id, status: report.status } });
}

/** GET /migration/dry-runs/:id/report */
async function report(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.getReport(tenantFromAuth(req), req.params.id, transaction));
  return success(res, { data });
}

module.exports = { start, report };
