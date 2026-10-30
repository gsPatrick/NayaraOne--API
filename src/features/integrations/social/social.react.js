'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registerDomainReaction, compensateDispatch } = require('../domain');
const mktRepo = require('../../marketing/content/pipeline.repository');
const { changeStatus } = require('../../marketing/content/content.status');
const { parseContentRef } = require('./social.payload');
const { AGGREGATE, OPERATION } = require('./social.publish');

const IN_FLIGHT = ['PENDING', 'SENDING', 'SUBMITTED', 'RETRY_WAIT', 'UNKNOWN'];

/** Evento de envio de um post (aggregate MarketingContentItem e operação publishPost), ou null. */
const postEvent = (event) => {
  const p = event.payloadJson || {};
  return p.dispatchId && p.aggregate && p.aggregate.type === AGGREGATE && p.aggregate.id && p.operation === OPERATION ? p : null;
};

/** Situação das redes do mesmo conteúdo e da mesma versão: quantas ainda estão em voo e quantas foram confirmadas. Redes reagendadas (CANCELLED) e envios de outra versão não contam. */
async function networksOf(ctx, itemId, dispatchId, transaction) {
  const [{ snapshot }] = await sequelize.query('SELECT payload_snapshot AS snapshot FROM integration.dispatches WHERE id = :id AND company_id = :c', { replacements: { id: dispatchId, c: ctx.companyId }, transaction, type: QueryTypes.SELECT });
  const ref = parseContentRef((snapshot || {}).contentRef);
  const rows = await sequelize.query(
    `SELECT status FROM integration.dispatches WHERE company_id = :c AND aggregate_type = :t AND aggregate_id = :i AND operation = :o AND payload_snapshot->>'contentRef' LIKE :p`,
    { replacements: { c: ctx.companyId, t: AGGREGATE, i: itemId, o: OPERATION, p: `mkt:${itemId}:${ref ? ref.versionId : ''}:%` }, transaction, type: QueryTypes.SELECT }
  );
  return { inFlight: rows.filter((r) => IN_FLIGHT.includes(r.status)).length, confirmed: rows.filter((r) => r.status === 'CONFIRMED').length };
}

const audit = (item, from, to, reason) => ({ entity: { type: AGGREGATE, id: item.id }, before: { status: from }, after: { status: to }, reason });

/**
 * `integration.dispatch.confirmed` de um post (M9-D239 + M9-D220 3.1 itens 2 e 5). SÓ por este evento o conteúdo muda de estado, e só quando o Marketing já o pôs em PUBLISHING (M9-D411):
 *  - quando nenhuma outra rede do mesmo conteúdo e versão está em voo, o conteúdo vai a PUBLISHED (a falha de uma rede não o impede: cada rede tem o seu envio);
 *  - ARCHIVED (o conteúdo foi retirado antes de o post chegar à rede): a rede agora mostra um post que o ERP já retirou, e a COMPENSAÇÃO é um novo envio `deletePost`
 *    (compensateDispatch); o envio de publicação original não é alterado e o conteúdo não volta a PUBLISHING;
 *  - qualquer outro estado não muda.
 */
async function onConfirmed(ctx, event, transaction) {
  const p = postEvent(event);
  if (!p) return null;
  const item = await mktRepo.lockItem(p.aggregate.id, transaction);
  if (!item) return null;
  if (item.status === 'ARCHIVED') {
    const r = await compensateDispatch(ctx, p.dispatchId, { transaction });
    return { entity: { type: AGGREGATE, id: item.id }, before: { status: item.status }, after: { status: item.status, compensationDispatchId: r.dispatch.id },
      reason: `Envio ${p.dispatchId} confirmado pela rede depois da retirada do conteúdo: remoção do post pedida (envio ${r.dispatch.id}).` };
  }
  if (item.status !== 'PUBLISHING') return null;
  const redes = await networksOf(ctx, item.id, p.dispatchId, transaction);
  if (redes.inFlight > 0) return null;
  await changeStatus({ tenant: ctx, actor: null, itemId: item.id, to: 'PUBLISHED', reason: `Envio ${p.dispatchId} confirmado pela rede: o conteúdo vai a PUBLISHED.` }, transaction);
  return audit(item, 'PUBLISHING', 'PUBLISHED', `Envio ${p.dispatchId} confirmado pela rede: o conteúdo vai a PUBLISHED.`);
}

/**
 * `integration.dispatch.failed` de um post: a rede não executou a operação (recusa, credencial, tentativas esgotadas). Falha ou ausência de resposta NUNCA desfaz o que outra rede já publicou:
 *  - enquanto houver rede em voo o conteúdo espera em PUBLISHING;
 *  - sem rede em voo: se alguma foi confirmada o conteúdo vai a PUBLISHED (a rede que falhou segue FAILED no seu envio, à vista da tela); se nenhuma foi, vai a FAILED para o Marketing reagendar.
 */
async function onFailed(ctx, event, transaction) {
  const p = postEvent(event);
  if (!p) return null;
  const item = await mktRepo.lockItem(p.aggregate.id, transaction);
  if (!item || item.status !== 'PUBLISHING') return null;
  const redes = await networksOf(ctx, item.id, p.dispatchId, transaction);
  if (redes.inFlight > 0) return null;
  const to = redes.confirmed > 0 ? 'PUBLISHED' : 'FAILED';
  const reason = `Envio ${p.dispatchId} falhou na rede (${(event.payloadJson || {}).errorClass || 'ERROR'}): o conteúdo vai a ${to}.`;
  await changeStatus({ tenant: ctx, actor: null, itemId: item.id, to, reason }, transaction);
  return audit(item, 'PUBLISHING', to, reason);
}

let installed = false;
function installSocialReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'integrations.social.dispatch_confirmed', handler: onConfirmed });
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'integrations.social.dispatch_failed', handler: onFailed });
}

module.exports = { installSocialReactions, onConfirmed, onFailed };
