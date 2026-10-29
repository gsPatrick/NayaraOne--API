'use strict';

const crypto = require('node:crypto');
const { MemoryService, MEMORY_CONTEXT_FIELDS } = require('../../memory');
const { buildContext, getTaskType } = require('../../security');

const service = new MemoryService();
const CLASS_ORDER = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const INSTRUCTION = 'Memórias vigentes da empresa: fatos operacionais autorizados, citáveis pela origem.';

const highest = (memories) => memories.reduce((top, m) => (CLASS_ORDER.indexOf(m.classification) > CLASS_ORDER.indexOf(top) ? m.classification : top), 'PUBLIC');

/** O provedor escolhido no formato do portão de classificação do ContextBuilder (D027). */
const descriptorOf = (policy = {}, code = null) => ({
  code, external: policy.labOnly !== true, allowsConfidential: policy.allowsConfidential === true, allowsRestricted: policy.allowsRestricted === true,
  dataRetention: policy.dataRetention || null, contractRef: policy.contractRef || null,
});

/**
 * Memórias do contexto do run (M9-D009): as VIGENTES para o ator (`MemoryService.recallAsSources`: invalidada, substituída ou expirada
 * nunca volta) passam pelo ContextBuilder da D027 (campos permitidos da tarefa, portão de classificação, redaction) e viram UMA fonte
 * `MEMORY` citável. Só entra memória se a tarefa lista os campos de memória na lista branca (`MEMORY_CONTEXT_FIELDS`) e se o guarda
 * de campos da IA (`deps.aiAccess`, M9-D915) existe: sem ele o ContextBuilder não monta contexto (falha fechada) e nenhuma memória sai.
 */
async function memorySources(state, policy) {
  const { aiAccess } = state.deps;
  if (!aiAccess || typeof aiAccess.assertAllowed !== 'function') return [];
  let task;
  try { task = getTaskType(state.parsed.taskType); } catch (err) { return []; }
  if (!MEMORY_CONTEXT_FIELDS.some((f) => task.fields.includes(f))) return [];
  const memories = await service.recallAsSources(state.ctx, { agent: state.agent.code, subject: state.parsed.subject }, state.transaction, { now: new Date(state.clock()) });
  if (!memories.length) return [];
  const built = await buildContext(state.ctx, {
    runId: state.runId, taskType: state.parsed.taskType, instruction: INSTRUCTION, purpose: state.parsed.purpose, provider: descriptorOf(policy, state.decision && state.decision.provider),
    sources: memories, agentContext: { agentCode: state.agent.code },
  }, state.transaction, { aiAccess });
  const text = built.messages[built.messages.length - 1].content;
  if (!text || text === '{}' || text === '[]' || text === 'null') return [];
  return [{
    sourceType: 'MEMORY', sourceRef: `memorias:${memories.map((m) => m.id).join(',')}`.slice(0, 255), sourceVersion: null, title: 'Memórias da empresa', clause: null, text, values: [],
    classification: highest(memories), effectiveFrom: null, effectiveUntil: null, relevanceScore: 1, statusAtRetrieval: 'VIGENTE',
    contentHash: crypto.createHash('sha256').update(text).digest('hex'), longDocument: false, retrievedAt: new Date(state.clock()), usedInAnswer: true,
  }];
}

module.exports = { memorySources, descriptorOf };
