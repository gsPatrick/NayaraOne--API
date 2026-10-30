'use strict';

const { readRunnerParams } = require('../runner/runner.settings');
const { resolveChannel } = require('../runner/runner.decide');
const repo = require('./review.repository');
const { readReviewParams } = require('./review.settings');
const { classify } = require('./review.classify');
const { satisfactionFacts } = require('./review.facts');
const { negative } = require('./review.negative');
const { positive, deliver } = require('./review.positive');

const CHANNELS = ['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL'];

/** Canal do pedido: o da ação (ou o primeiro canal automático em que a pessoa tem contato). A nota negativa não envia nada, então cai no canal da pesquisa ou no primeiro automático. */
async function channelOf(input, facts, { allowFallback }) {
  const runnerParams = await readRunnerParams(input.tenant, input.transaction);
  const resolved = await resolveChannel({ channel: input.channel }, input.personId ? { id: input.personId } : null, { tenant: input.tenant, transaction: input.transaction, params: runnerParams, event: {} });
  if (resolved) return resolved;
  if (!allowFallback) return null;
  return CHANNELS.includes(facts.channel) ? facts.channel : runnerParams.autoChannels[0];
}

/**
 * Serviço de pedido de avaliação (M9-D424), registrado na porta do runner. Recebe { tenant, transaction, personId, platform, channel, idempotencyKey, correlationId, ... } e devolve
 * { reviewRequestId, ... }. Repetir a mesma chave (ou a mesma origem da satisfação) devolve o mesmo pedido, sem criar outro. Nota negativa: ocorrência antes e nenhum envio;
 * positiva: pedido com link rastreável, só sem ocorrência aberta; entre as duas notas, nenhuma ação.
 */
async function requestReview(input) {
  const { tenant, transaction, personId } = input;
  if (!personId) return { reviewRequestId: null, blocked: 'NO_ADDRESS' };
  await repo.lockPerson(personId, transaction);
  const existing = await repo.findByKey(input.idempotencyKey, transaction);
  const params = await readReviewParams(tenant, transaction);
  if (existing) return existing.status === 'PENDING' ? deliver(existing, input, params) : { reviewRequestId: existing.id, replay: true };
  const facts = await satisfactionFacts({ context: input.context, transaction });
  if (!facts) return { reviewRequestId: null, blocked: 'MKT_REVIEW_FACTS_MISSING' };
  const kind = classify(facts.score, params);
  if (kind !== 'NEGATIVE' && kind !== 'POSITIVE') return { reviewRequestId: null, blocked: 'NO_ACTION_FOR_SCORE' };
  const origin = await repo.findByOrigin(personId, facts.sourceType, facts.sourceId, transaction);
  if (origin) return { reviewRequestId: origin.id, replay: true };
  const channel = await channelOf(input, facts, { allowFallback: kind === 'NEGATIVE' });
  return kind === 'NEGATIVE' ? negative({ input, facts, channel }) : positive({ input, facts, params, channel });
}

module.exports = { requestReview };
