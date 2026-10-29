'use strict';

const crypto = require('node:crypto');
const E = require('./memory.errors');
const V = require('./memory.input');
const { PROPOSAL_TYPE } = require('./memory.constants');
const { createRecommendation } = require('../recommendations/recommendation.create');

/** UUID determinístico do conteúdo: a mesma proposta no mesmo dia cai na mesma recomendação pendente (dedup da D007). */
function proposalId(parts) {
  const h = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A NAY propõe uma memória (regra 5): nasce uma recomendação PENDING do tipo MEMORY_PROPOSAL com a memória no payload (sem PII nem
 * segredo, pela sanitização da D007). Nada é gravado em ai.memories: uma pessoa com ai:admin grava depois, citando a recomendação
 * como origem. `data`: { agentCode, memory: { type, scope, value, ... }, targetUserId }.
 */
async function proposeMemory(ctx, data, transaction) {
  V.ctxOk(ctx);
  if (!V.isObject(data)) throw E.invalid('Dados da proposta ausentes.');
  const memory = V.isObject(data.memory) ? data.memory : {};
  if (!V.isObject(memory.value)) throw E.invalid('A proposta precisa de um valor estruturado.');
  const { type, scope, subjectType, subjectId } = V.parseSave({ ...memory, sourceType: 'RECOMMENDATION', sourceId: memory.sourceId || crypto.randomUUID() });
  const { value, ...meta } = memory;
  return createRecommendation(ctx, {
    agentCode: data.agentCode,
    relatedEntityType: 'AiMemory',
    relatedEntityId: proposalId([type, scope, subjectType, subjectId, value]),
    recommendationType: PROPOSAL_TYPE,
    title: `Proposta de memória: ${type}`,
    rationale: 'A NAY propõe guardar este fato como memória da empresa. Só uma pessoa com permissão de administração grava.',
    riskLevel: 'LOW',
    targetUserId: data.targetUserId,
    payload: { memory: { ...meta, value } },
  }, transaction);
}

module.exports = { proposeMemory };
