'use strict';

const grants = require('../grants/grant.service');
const { withOwnTenantTransaction } = require('../guard.tx');
const { readDownloadParams } = require('./download.params');
const { deliverFiles } = require('./download.deliver');

/**
 * GET /files/downloads/:id?exp&sig (M9-D920 §3.3): o endereço assinado de uso único. Ordem das recusas: pedido de outra pessoa 403, falhou 409, já usado 410, vencido 410
 * GOV_EXPORT_EXPIRED, assinatura 403. Aprovado, entrega o arquivo (ou o zip) com a marca d'água do pedido e audita com IP e agente.
 */
async function serveGrant({ tenant, auth, jobId, exp, sig, ip, userAgent }) {
  return withOwnTenantTransaction(tenant, auth.userId, async (transaction) => {
    const job = await grants.open({ tenant, actorUserId: auth.userId, jobId, kind: 'DOWNLOAD', exp, sig }, transaction);
    const params = await readDownloadParams(tenant, transaction);
    const fileIds = job.resourceRef && Array.isArray(job.resourceRef.fileIds) ? job.resourceRef.fileIds : [];
    return deliverFiles({ tenant, auth, job: { id: job.id, classification: job.classification, watermark: job.watermark, fileIds }, ip, userAgent, params, transaction });
  });
}

module.exports = { serveGrant };
