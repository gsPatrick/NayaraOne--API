'use strict';

const ports = require('../runner.ports');
const receipt = require('./receipt');
const { resultOfSend, registerOpenActionCloser } = require('../runner.sendRetry');

/**
 * REQUEST_REVIEW -> serviço de pedido de avaliação (M9-D424, registrado na porta do runner) com a action_key como Idempotency-Key: repetir a chave devolve o mesmo pedido.
 * O serviço devolve { reviewRequestId } e, conforme o caso, `deferUntil` (horário de silêncio: a ação espera e o executor das ações adiadas a retoma), `blocked`/`failed`
 * (recusa de negócio: ação SKIPPED com o código, sem derrubar a run) ou `unknown` (resultado incerto). O recibo é gravado depois do serviço, porque a própria chave do serviço já impede o segundo pedido.
 */
async function requestReview(ctx) {
  const { def, entry, subject, tenant, transaction } = ctx;
  const out = await ports.requestReview({
    tenant, transaction, personId: subject ? subject.id : null, platform: def.platform || null, channel: def.channel || null, idempotencyKey: entry.action_key, correlationId: ctx.correlationId,
    now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, flowId: ctx.flow.id, ownerUserId: ctx.flow.ownerUserId || null,
    context: { eventId: ctx.event.eventId, payload: ctx.event.payload, message: { text: def.text, subject: def.subject, templateId: def.templateId, preheader: def.preheader } },
  });
  const providerRef = out && out.reviewRequestId ? out.reviewRequestId : null;
  if (out && out.deferUntil) return { status: 'SCHEDULED', dueAt: out.deferUntil, providerRef };
  // DI-M9F-2: a mensagem do pedido ficou incerta (timeout) ou numa falha transitória: a ação fica aberta (UNKNOWN reconciliado pela chave, ou RETRY com backoff), sem
  // recibo, para a retomada rodar o pedido de novo com a mesma chave; o pedido continua PENDING. Esgotou: o pedido fecha FAILED (closer abaixo) e a ação também.
  if (out && (out.retry || out.unknown)) {
    const open = { ...entry, channel: out.channel };
    const r = await resultOfSend(ctx, open, out.unknown ? { ok: false, unknown: true, errorCode: 'CHANNEL_UNKNOWN' } : out.retry);
    return { ...r, providerRef, fields: { ...(r.fields || {}), channel: out.channel } };
  }
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  if (providerRef) await receipt.setDestination(ctx, providerRef);
  if (out && out.unknown) return { status: 'UNKNOWN', providerRef, errorCode: 'MKT_ACTION_UNKNOWN' };
  if (out && (out.blocked || out.failed)) return { status: 'SKIPPED', providerRef, errorCode: out.blocked || out.failed };
  return { status: 'OK', providerRef };
}

/** Fecha o pedido PENDING da ação aberta que terminou sem a mensagem sair (bloqueio, pausa, tentativas ou consultas esgotadas), pelo próprio serviço do pedido. */
async function closeReviewRequest(ctx, entry, { status, code }) {
  await ports.requestReview({
    tenant: ctx.tenant, transaction: ctx.transaction, personId: ctx.subject ? ctx.subject.id : null, idempotencyKey: entry.action_key, ownerUserId: ctx.flow ? ctx.flow.ownerUserId || null : null,
    now: ctx.now, close: { status, code },
  });
}
registerOpenActionCloser('REQUEST_REVIEW', closeReviewRequest);

module.exports = { requestReview };
