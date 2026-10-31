'use strict';

const { success } = require('../../utils/httpResponse');
const logger = require('../../utils/logger');
const service = require('./ingest/runs.service');
const { executeRun } = require('./ingest/executor');
const { replayBatch } = require('./ingest/replay');
const ingestErrors = require('./ingest/ingest.errors');
const { verifyPending } = require('./integrity/verify.job');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

/** POST /migration/runs -> 202 { runId }. A execução parte logo depois da resposta (o job retoma se este processo cair). */
async function createRun(req, res) {
  const tenant = tenantFromAuth(req);
  const data = await req.withTenantTransaction((transaction) => service.createRun(tenant, { userId: req.auth.userId }, req.body, transaction));
  setImmediate(() => executeRun(tenant, data.runId).then(() => verifyPending(tenant, { userId: req.auth.userId })).catch((err) => logger.error({ runId: data.runId, err: err.message }, 'migration.run.failed')));
  return success(res, { statusCode: 202, data });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /migration/batches/:id/replay -> 200: reaplica o intervalo do lote como um NOVO lote (replay_of = o original); o original não muda de estado (M9-D900 §3.4). */
async function replay(req, res) {
  if (!UUID.test(req.params.id)) throw ingestErrors.batchNotFound();
  const result = await replayBatch(tenantFromAuth(req), { userId: req.auth.userId }, req.params.id);
  return success(res, { data: { batchId: result.batch.id, replayOf: result.batch.replay_of, status: result.batch.status, rootHash: result.batch.root_hash, counts: result.counts } });
}

module.exports = { createRun, replay };
