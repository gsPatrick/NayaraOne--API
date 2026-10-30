'use strict';

const { Op } = require('sequelize');
const { SitePage, IntegrationConnection, IntegrationDispatch } = require('../../../models');
const logger = require('../../../utils/logger');
const adapterRegistry = require('../registry/adapterRegistry');
const { invoke } = require('../registry/adapterInvoke');
const { readReconcileParams, waitBeforeAttemptS } = require('../dispatch/reconcile/reconcile.params');
const { readWorkerParams } = require('../dispatch/worker/worker.params');
const { applyExternalPageStatus } = require('./site.apply');
const { SYNC, UNPUBLISH } = require('./site.constants');

const httpStatusOf = (e) => Number(e && (e.status ?? e.statusCode));

/** A consulta da página está devida? Primeira consulta a partir da criação do envio; depois a espera cresce pela mesma tabela de consultas da reconciliação (D215). */
function isDue(page, envio, params, now) {
  const base = page.statusCheckedAt || envio.submittedAt || envio.updatedAt || envio.createdAt;
  return now.getTime() >= new Date(base).getTime() + waitBeforeAttemptS(params, page.statusChecks) * 1000;
}

/** Consulta o status de UMA página no site e aplica. Site fora não derruba nada: conta a consulta, guarda o erro e segue. */
async function checkOne(ctx, page, now, params, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: page.connectionId, companyId: ctx.companyId }, transaction });
  if (!connection || connection.status !== 'ACTIVE') return { skipped: true };
  await page.update({ statusChecks: page.statusChecks + 1, statusCheckedAt: now }, { transaction });
  let externo;
  try {
    const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
    const r = await invoke(adapter, 'getPageStatus', { pageKey: page.pageKey }, { tenant: ctx, transaction });
    externo = { status: r.status };
  } catch (err) {
    if (httpStatusOf(err) !== 404) {
      await page.update({ lastError: `Não foi possível consultar o site: ${String(err.message || err.code).slice(0, 200)}` }, { transaction });
      return { error: err.code || 'ERROR' };
    }
    // O site não conhece a página: para uma retirada isso é a própria confirmação (já não existe); para uma publicação, a consulta conta e a próxima vem depois.
    if (page.dispatchOperation !== UNPUBLISH) return { notFound: true };
    externo = { status: 'UNPUBLISHED' };
  }
  const r = await applyExternalPageStatus(ctx, page, { ...externo, source: 'STATUS_QUERY' }, transaction);
  return { applied: r.applied, reason: r.reason };
}

/**
 * Passo da rodada do worker de envios (M9-D259 3.2 item 3): as páginas com envio ACEITO pelo site (SUBMITTED) e ainda não confirmado são consultadas por `getPageStatus` nos prazos de
 * `integration.unknown.reconcile_intervals_s`, até `integration.unknown.max_reconcile_attempts` consultas. Esgotadas sem confirmação, a página fica com site_sync_status FAILED (o estado interno
 * não muda; o webhook assinado ainda pode confirmar). No máximo `worker_batch_size` páginas por rodada. Devolve { checked, applied }.
 */
async function syncSitePages(ctx, { now = new Date() } = {}, transaction) {
  const [params, worker] = await Promise.all([readReconcileParams(ctx, transaction), readWorkerParams(ctx, transaction)]);
  const candidatas = await SitePage.findAll({
    where: { companyId: ctx.companyId, siteSyncStatus: SYNC.PENDING_SYNC, dispatchId: { [Op.ne]: null }, dispatchConfirmed: false }, order: [['updated_at', 'ASC']], limit: worker.batchSize * 3, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const resultado = { checked: 0, applied: 0 };
  for (const page of candidatas) {
    if (resultado.checked >= worker.batchSize) break;
    // eslint-disable-next-line no-await-in-loop
    const envio = await IntegrationDispatch.findOne({ where: { id: page.dispatchId, companyId: ctx.companyId }, transaction });
    if (!envio || envio.status !== 'SUBMITTED') continue;
    if (page.statusChecks >= params.maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await page.update({ siteSyncStatus: SYNC.FAILED, lastError: 'O site não confirmou a operação depois das consultas previstas.' }, { transaction });
      continue;
    }
    if (!isDue(page, envio, params, now)) continue;
    resultado.checked += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await checkOne(ctx, page, now, params, transaction);
      if (r.applied) resultado.applied += 1;
    } catch (err) {
      logger.warn({ pageId: page.id, err: err.message }, 'Site: a consulta de status da página não pôde rodar.');
    }
  }
  return resultado;
}

module.exports = { syncSitePages, checkOne, isDue };
