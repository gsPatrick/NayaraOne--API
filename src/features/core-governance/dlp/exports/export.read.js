'use strict';

const { ADMIN_PERMISSION } = require('../dlp.constants');
const errors = require('./export.errors');
const repo = require('./export.repository');
const { exportView } = require('./export.view');
const { readExportParams } = require('./export.params');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O pedido da empresa, ou 404 (id malformado, inexistente ou de outra empresa, já filtrado pela RLS). */
async function loadJob(tenant, id, transaction) {
  const job = UUID.test(String(id)) ? await repo.findById(tenant.companyId, id, transaction) : null;
  if (!job) throw errors.notFound();
  return job;
}

/** Só quem pediu (ou governance:dlp:admin) vê e baixa o arquivo (M9-D822 §3.2 item 3). */
function assertOwnerOrAdmin(job, actorUserId, permissions) {
  if (job.actorUserId !== actorUserId && !(permissions || []).includes(ADMIN_PERMISSION)) throw errors.notOwner();
}

/** GET /exports/:id. */
async function getExport({ tenant, actorUserId, permissions, id, transaction, now = new Date() }) {
  const job = await loadJob(tenant, id, transaction);
  assertOwnerOrAdmin(job, actorUserId, permissions);
  const params = await readExportParams(tenant, transaction);
  return { ...exportView(job, { userId: job.actorUserId, now, urlMinutes: params.urlMinutes }), blockReason: job.blockReason };
}

module.exports = { loadJob, assertOwnerOrAdmin, getExport };
