'use strict';

const { callEnvelope } = require('./signature.adapter');
const { findActive } = require('../../integrations/contingency/contingency.state');

/** Erros em que a pergunta está errada ou a pessoa não pode (4xx de negócio): continuam erro. Qualquer outro (fornecedor fora, circuito aberto, tempo esgotado) deixa o estado UNKNOWN. */
const BUSINESS = [400, 401, 403, 404, 409, 422];

/**
 * Consulta de status do envelope com o fornecedor FORA (M9-D227 3.3): em vez de falhar, o estado é UNKNOWN (nada é presumido: nem assinado nem cancelado) e a assinatura local
 * não muda. Devolve a resposta normalizada ou `{ status: 'UNKNOWN', unavailable: true, reason }`.
 */
async function queryEnvelopeStatus(ctx, envelope, transaction) {
  // Contingência ativa para a connection do envelope: não se insiste no fornecedor que caiu; o estado é UNKNOWN até ele voltar.
  if (envelope.connectionId && await findActive(ctx, { connectionId: envelope.connectionId }, transaction)) return { status: 'UNKNOWN', unavailable: true, reason: 'CONTINGENCY_ACTIVE' };
  try {
    return await callEnvelope(ctx, envelope, 'getEnvelope', { externalResourceId: envelope.externalEnvelopeId }, transaction);
  } catch (err) {
    const http = Number(err && (err.statusCode ?? err.status));
    if (BUSINESS.includes(http) && !String(err.code || '').startsWith('INTEGRATION_CIRCUIT')) throw err;
    return { status: 'UNKNOWN', unavailable: true, reason: String((err && err.code) || 'PROVIDER_UNAVAILABLE').slice(0, 80) };
  }
}

module.exports = { queryEnvelopeStatus };
