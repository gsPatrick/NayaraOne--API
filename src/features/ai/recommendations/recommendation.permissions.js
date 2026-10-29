'use strict';

const E = require('./recommendation.errors');

const has = (ctx, code) => Array.isArray(ctx.permissions) && ctx.permissions.includes(code);

/** A NAY (identidade de serviço) e qualquer contexto sem pessoa nunca decidem (AI-007: a NAY não recebe bypass). */
function assertHuman(ctx) {
  if (!ctx || ctx.serviceIdentity === true || ctx.actorType === 'NAY' || !ctx.userId) throw E.humanOnly();
}

/**
 * Quem pode decidir. Recomendação COM ação proposta exige ai:approve. Informativa (sem ação): o próprio destinatário com
 * ai:read, ou quem tem ai:approve. Informativa nunca executa nada.
 */
function assertCanDecide(ctx, rec) {
  if (has(ctx, 'ai:approve')) return;
  if (!rec.proposedAction && rec.targetUserId && rec.targetUserId === ctx.userId && has(ctx, 'ai:read')) return;
  throw E.denied(rec.proposedAction ? 'ai:approve' : 'ai:read|ai:approve');
}

/** Quem pode ver uma recomendação: ai:audit/ai:approve veem a empresa; ai:read vê só as dirigidas à pessoa. */
function visibility(ctx) {
  if (has(ctx, 'ai:audit') || has(ctx, 'ai:approve')) return 'COMPANY';
  if (has(ctx, 'ai:read') && ctx.userId) return 'OWN';
  throw E.denied('ai:read');
}

module.exports = { assertHuman, assertCanDecide, visibility, has };
