'use strict';

const { withOwnTenantTransaction } = require('../guard.tx');
const repo = require('./grant.repository');
const errors = require('./grant.errors');
const { signGrantUrl, verifyGrantUrl } = require('./grant.url');

/**
 * Pedido DOWNLOAD ou PRINT aprovado pelo guard vira um endereço assinado de uso único (M9-D920 §3.1 e §3.3). Os passos que mudam o pedido rodam em transação própria e
 * confirmada (como o registro do guard): a recusa que sobe depois não desfaz o prazo, a falha nem o fim do pedido.
 *  - emit: prazo = o MENOR entre `urlMinutes` e o teto da política da classe (obrigação `expiresAt` da decisão); grava prazo, marca d'água e o que será entregue.
 *  - open: confere dono, vencimento, uso anterior e assinatura, nesta ordem; vencido marca EXPIRED.
 *  - consume: usa o endereço (atômico); se outro pedido chegou antes, 410 GOV_DOWNLOAD_ALREADY_USED.
 *  - fail: o pedido termina FAILED com o código da causa (ex.: GOV_FILE_WATERMARK_FAILED).
 */
async function emit({ tenant, actorUserId, decision, kind, basePath, urlMinutes, watermark, resourceRef, now = new Date() }) {
  const cap = decision.obligations && decision.obligations.expiresAt ? new Date(decision.obligations.expiresAt).getTime() : Infinity;
  const until = new Date(Math.min(now.getTime() + urlMinutes * 60000, cap));
  const { url, expiresAt } = signGrantUrl({ kind, jobId: decision.job.id, userId: actorUserId, basePath, expiresAt: until });
  const job = await withOwnTenantTransaction(tenant, actorUserId, (tx) => repo.attachGrant(tenant.companyId, decision.job.id, { expiresAt, watermark, resourceRef }, tx));
  return { exportJobId: job.id, status: job.status, url, expiresAt, classification: job.classification, watermark: job.watermark };
}

async function open({ tenant, actorUserId, jobId, kind, exp, sig, now = new Date() }, transaction) {
  const job = /^[0-9a-f-]{36}$/i.test(String(jobId)) ? await repo.findGrant(tenant.companyId, jobId, kind, transaction) : null;
  if (!job) throw errors.notAvailable();
  if (job.actorUserId !== actorUserId) throw errors.notOwner();
  if (job.status === 'FAILED') throw errors.failed(job.errorCode);
  if (job.status === 'READY' || job.downloadCount > 0) throw errors.alreadyUsed();
  if (job.status === 'EXPIRED' || (job.expiresAt && new Date(job.expiresAt) <= now)) {
    await withOwnTenantTransaction(tenant, actorUserId, (tx) => repo.markExpired(tenant.companyId, job.id, tx));
    throw errors.expired();
  }
  if (job.status !== 'APPROVED') throw errors.notAvailable();
  verifyGrantUrl({ kind, jobId: job.id, userId: job.actorUserId, exp, sig, now });
  return job;
}

async function consume(tenant, jobId, transaction) {
  const job = await repo.consume(tenant.companyId, jobId, transaction);
  if (!job) throw errors.alreadyUsed();
  return job;
}

const fail = (tenant, actorUserId, jobId, code) => withOwnTenantTransaction(tenant, actorUserId, (tx) => repo.markFailed(tenant.companyId, jobId, code, tx));

module.exports = { emit, open, consume, fail };
