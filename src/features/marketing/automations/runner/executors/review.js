'use strict';

const ports = require('../runner.ports');
const receipt = require('./receipt');

/** REQUEST_REVIEW -> requestReview (serviço da M9-D424, registrado na porta do runner) com a action_key como Idempotency-Key. */
async function requestReview(ctx) {
  const { def, subject, tenant, transaction } = ctx;
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const out = await ports.requestReview({ tenant, transaction, personId: subject ? subject.id : null, platform: def.platform || null, channel: def.channel || null, idempotencyKey: ctx.entry.action_key, correlationId: ctx.correlationId });
  if (out && out.reviewRequestId) await receipt.setDestination(ctx, out.reviewRequestId);
  return { status: 'OK', providerRef: out && out.reviewRequestId ? out.reviewRequestId : null };
}

module.exports = { requestReview };
