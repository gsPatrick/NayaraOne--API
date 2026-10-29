'use strict';

const crypto = require('node:crypto');
const { numbersFromToolOutput } = require('../../tools/numbers/financeNumbers');
const { detectInjection } = require('../injectionDetector');
const { publishInjectionEvents } = require('../injectionEvents');
const E = require('./flow.errors');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const textOf = (output) => (typeof output === 'string' ? output : JSON.stringify(output));

/**
 * O resultado de uma tool de leitura vira fonte do run (`TOOL_RESULT`, exata e vigente) e, se a tool é financeira, ganha o
 * `numbersPayload` do read model (D026). Conteúdo recuperado por tool com instrução de override ou exfiltração (no limiar de
 * bloqueio) termina o run BLOCKED na hora, 422 AI_INJECTION_BLOCKED, sem resposta parcial; no limiar de alerta fica rotulado.
 */
async function absorbToolOutput(state, toolName, output) {
  const text = textOf(output);
  const det = detectInjection(text, state.injectionLimits);
  if (det.action !== 'ALLOW') {
    const sourceId = `tool-${toolName}`;
    await publishInjectionEvents(state.ctx, state.runId, [{ sourceId, origin: 'TOOL_RESULT', ...det, action: det.action === 'QUARANTINE' ? 'QUARANTINED' : 'SUSPICIOUS' }], state.transaction);
    if (det.action === 'QUARANTINE') throw E.injectionInContent();
  }
  state.sources.push({
    sourceType: 'TOOL_RESULT', sourceRef: toolName, sourceVersion: null, title: toolName, clause: null, text, values: [], classification: 'INTERNAL',
    effectiveFrom: null, effectiveUntil: null, relevanceScore: null, statusAtRetrieval: 'VIGENTE', contentHash: sha(text), longDocument: false,
    retrievedAt: new Date(state.clock()), usedInAnswer: true,
  });
  state.numbersPayload.push(...numbersFromToolOutput(toolName, output));
}

module.exports = { absorbToolOutput, textOf };
