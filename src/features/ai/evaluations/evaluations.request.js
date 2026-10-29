'use strict';

const V = require('./evaluations.validation');
const E = require('./evaluations.errors');
const C = require('./evaluations.constants');
const repo = require('./evaluations.repository');
const { readEvaluationParams } = require('./evaluations.params');
const { hasEvalProvider } = require('./evalProviders');
const { auditEvaluation } = require('./evaluations.events');
const { toEvaluation } = require('./evaluations.mapper');
const agentRepo = require('../agents/agents.repository');
const { requireOwn } = require('../agents/agentAccess');

/**
 * Enfileira uma avaliação (POST /ai/evaluations/run): valida a versão da empresa, só aceita o provider de testes (ou, com
 * `ia.avaliacao.permitir_provider_real` ligado, um provider real registrado) e grava QUEUED. A chave de idempotência devolve a
 * mesma avaliação sem duplicar. A execução é assíncrona (processQueued); o resultado se lê em GET /ai/evaluations/:id.
 */
async function requestEvaluation(ctx, body, transaction) {
  V.ctxOk(ctx);
  const data = V.parseRunBody(body);
  if (data.idempotencyKey) {
    const previous = await repo.findByIdempotency(ctx, data.idempotencyKey, transaction);
    if (previous) {
      const same = previous.agentCode === data.agentCode && previous.suite === data.suite && (!data.agentVersion || previous.agentVersion === data.agentVersion);
      if (!same) throw E.invalid('Esta chave de idempotência já foi usada com outro pedido.');
      return { evaluation: toEvaluation(previous), replayed: true };
    }
  }
  const params = await readEvaluationParams(ctx, transaction);
  if (data.providerCode !== C.SANDBOX_PROVIDER) {
    if (!params.allowRealProvider) throw E.realProviderDisabled();
    if (!hasEvalProvider(data.providerCode)) throw E.providerNotFound();
  }
  const version = data.agentVersion || (await agentRepo.latestVersionNumber(ctx, data.agentCode, transaction)) || 1;
  await requireOwn(ctx, data.agentCode, version, transaction);
  const row = await repo.insertQueued(ctx, { ...data, agentVersion: version }, transaction);
  const evaluation = toEvaluation(row);
  await auditEvaluation(ctx, 'ai.evaluation.queued', evaluation, null, `Avaliação da versão ${version} do agente ${data.agentCode} enfileirada (${data.suite}).`, transaction);
  return { evaluation, replayed: false };
}

module.exports = { requestEvaluation };
