'use strict';

const { resolveDispatchByEvent } = require('../dispatch/reconcile/reconcile.event');
const { currentDispatch } = require('./site.store');
const { RANK, STATUS } = require('../providers/site/site.status');
const { PUBLISH, UNPUBLISH } = require('./site.constants');

/**
 * applyExternalPageStatus — aplica o estado que o site informou (webhook assinado ou consulta de status, a mesma regra de ordem) à página, DENTRO do envio corrente (M9-D259 3.1):
 *  - a ordem vale só dentro do mesmo envio: PENDING=0, PUBLISHED=1, UNPUBLISHED=1; evento com posição menor que a já aplicada não regride o estado;
 *  - PUBLISHED só pertence ao envio de publicação e UNPUBLISHED ao de retirada (operações diferentes têm a mesma posição); o status da outra operação é ignorado;
 *  - FAILED é terminal: é aplicado depois de PENDING, nunca depois de um status que já confirmou o envio, e nada mais é aplicado depois dele no mesmo envio;
 *  - republicar a página abre um envio novo e o ciclo recomeça em PENDING, por isso um UNPUBLISHED anterior nunca faz o PENDING seguinte ser ignorado.
 * PUBLISHED e UNPUBLISHED confirmam o envio (STATUS_QUERY ou WEBHOOK_SIGNED), o que publica `integration.dispatch.confirmed` uma vez; quem marca a página como publicada é a reação a esse evento
 * (site.react.js), nunca a resposta HTTP. FAILED leva o envio a FAILED (`integration.dispatch.failed`). `external`: { status, source, reason? }. Devolve { applied, reason? }.
 */
async function applyExternalPageStatus(ctx, page, external, transaction) {
  const status = String(external.status || '').toUpperCase();
  const operation = page.dispatchOperation;
  const ignorar = (reason) => ({ applied: false, reason });
  if (!page.dispatchId || !operation) return ignorar('NO_DISPATCH');
  if (page.appliedStatus === STATUS.FAILED) return ignorar('TERMINAL');
  if (status === STATUS.FAILED) {
    if (page.dispatchConfirmed) return ignorar('ALREADY_CONFIRMED');
  } else {
    if (!Object.prototype.hasOwnProperty.call(RANK, status)) return ignorar('UNKNOWN_STATUS');
    if ((status === STATUS.PUBLISHED && operation !== PUBLISH) || (status === STATUS.UNPUBLISHED && operation !== UNPUBLISH)) return ignorar('OPERATION_MISMATCH');
    if (RANK[status] < page.appliedRank) return ignorar('OUT_OF_ORDER');
  }
  const envio = await currentDispatch(ctx, page, transaction);
  if (!envio) return ignorar('NO_DISPATCH');
  const patch = { appliedStatus: status, appliedRank: status === STATUS.FAILED ? page.appliedRank : RANK[status] };
  if (status === STATUS.FAILED) patch.lastError = external.reason ? String(external.reason).slice(0, 300) : 'O site recusou a operação.';
  if (status === STATUS.PUBLISHED || status === STATUS.UNPUBLISHED) patch.dispatchConfirmed = true;
  await page.update(patch, { transaction });
  if (status !== STATUS.PENDING) {
    await resolveDispatchByEvent(ctx, { providerCode: envio.providerCode, idempotencyKey: envio.idempotencyKey, status, source: external.source === 'WEBHOOK_SIGNED' ? 'WEBHOOK_SIGNED' : 'STATUS_QUERY' }, {}, transaction);
  }
  return { applied: true };
}

module.exports = { applyExternalPageStatus };
