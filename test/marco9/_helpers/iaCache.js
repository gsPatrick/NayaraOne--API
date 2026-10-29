'use strict';

// Apoio dos testes do cache seguro (M9-D015): fonte do índice (chunk ACTIVE) com os dados que o cache guarda, dados de gravação e entrada
// do roteador. Banco descartável, role nayara_runtime, rollback.
const { semear } = require('./ragSeed');
const { uid, q } = require('../../helpers/aiAgents');

const TEXTO = 'O reembolso de cliente é feito em 7 dias úteis.';

/** Fonte ACTIVE no índice e a fonte no formato do run (KNOWLEDGE_ENTRY). `over` muda campos da fonte (classificação, tipo...). */
async function fonteIndexada(tenant, tx, over = {}) {
  const sourceId = uid();
  await semear(tenant, tx, { texto: TEXTO, sourceType: 'KNOWLEDGE_ENTRY', sourceId, version: 1 });
  return {
    sourceType: 'KNOWLEDGE_ENTRY', sourceRef: sourceId, sourceVersion: '1', title: 'Política de reembolso', clause: null, text: TEXTO, values: [], classification: 'INTERNAL',
    effectiveFrom: null, effectiveUntil: null, relevanceScore: 1, statusAtRetrieval: 'VIGENTE', contentHash: 'a'.repeat(64), longDocument: false, retrievedAt: new Date('2026-10-01T12:00:00Z'), ...over,
  };
}

/** Dados de gravação elegíveis por padrão; `over` quebra uma condição por vez. */
const dados = (fontes, over = {}) => ({
  agentCode: 'NAY_CACHE', agentVersion: 1, taskType: 'resumir_faq', cacheableTaskTypes: ['resumir_faq'], permissions: ['ai:use', 'crm:opportunities:read'], input: 'Qual o prazo do reembolso?',
  purpose: 'Consulta de FAQ', answer: 'O reembolso é feito em 7 dias úteis [1].', sources: fontes, groundingStatus: 'GROUNDED', isAction: false, snapshotAt: null,
  providerCode: 'ai-sandbox', modelCode: 'sandbox-1', ...over,
});

/** A entrada que o roteador entrega a `lookup` para os mesmos dados. */
const entradaLookup = (d) => ({
  agentCode: d.agentCode, agentVersion: d.agentVersion, taskType: d.taskType, cacheableTaskTypes: d.cacheableTaskTypes,
  ruleInput: { taskType: d.taskType, input: d.input, purpose: d.purpose, agentCode: d.agentCode, userId: null, permissions: d.permissions },
});

const contar = async (tx) => Number((await q('SELECT count(*)::int AS n FROM ai.cache_entries', {}, tx))[0].n);

module.exports = { fonteIndexada, dados, entradaLookup, contar, TEXTO };
