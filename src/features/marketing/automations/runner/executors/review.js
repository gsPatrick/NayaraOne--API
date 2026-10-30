'use strict';

const ports = require('../runner.ports');
const receipt = require('./receipt');

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
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  if (providerRef) await receipt.setDestination(ctx, providerRef);
  if (out && out.unknown) return { status: 'UNKNOWN', providerRef, errorCode: 'MKT_ACTION_UNKNOWN' };
  if (out && (out.blocked || out.failed)) return { status: 'SKIPPED', providerRef, errorCode: out.blocked || out.failed };
  return { status: 'OK', providerRef };
}

module.exports = { requestReview };
