'use strict';

const { success } = require('../../utils/httpResponse');
const logger = require('../../utils/logger');
const service = require('./ingest/runs.service');
const { executeRun } = require('./ingest/executor');
const { verifyPending } = require('./integrity/verify.job');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

/** POST /migration/runs -> 202 { runId }. A execução parte logo depois da resposta (o job retoma se este processo cair). */
async function createRun(req, res) {
  const tenant = tenantFromAuth(req);
  const data = await req.withTenantTransaction((transaction) => service.createRun(tenant, { userId: req.auth.userId }, req.body, transaction));
  setImmediate(() => executeRun(tenant, data.runId).then(() => verifyPending(tenant, { userId: req.auth.userId })).catch((err) => logger.error({ runId: data.runId, err: err.message }, 'migration.run.failed')));
  return success(res, { statusCode: 202, data });
}

module.exports = { createRun };
