'use strict';

// Fábricas e leituras do outbox para os testes dos eventos ai.* (M9-D029). Rodam com nayara_runtime (RLS real).

const crypto = require('node:crypto');
const { q } = require('../../helpers/aiRuns');
const runs = require('../../../src/features/ai/orchestrator/runs');

const SEIS_RUN_COMPLETED = ['agentCode', 'agentVersion', 'costAmount', 'groundingStatus', 'latencyMs', 'model', 'provider', 'routingPath', 'runId'];

/** Eventos do tipo para o agregado, mais antigo primeiro. */
const eventos = (tipo, aggregateId, tx) => q('SELECT * FROM integration.outbox_events WHERE event_type = :t AND aggregate_id = :id ORDER BY occurred_at', { t: tipo, id: aggregateId }, tx);

const chaves = (e) => Object.keys(e.payload_json).sort();

/** Abre um run (pergunta com PII de propósito) e devolve o id. */
async function abrirRun(ctx, tx, extra = {}) {
  const { run } = await runs.startRun(ctx, {
    agentName: 'NAY_FINANCEIRA', purpose: 'teste', inputSummary: 'Pergunta de maria.silva@empresa.com.br, CPF 111.444.777-35', idempotencyKey: crypto.randomUUID(), ...extra,
  }, tx);
  return run;
}

/** Texto do JSON do evento sem PII, prompt nem documento. */
const CAMPOS_PROIBIDOS = ['prompt', 'inputSummary', 'outputSummary', 'text', 'content', 'document', 'email', 'cpf', 'rationale', 'title', 'decisionReason', 'reason_text'];
function assertSemPii(assert, evento) {
  const json = JSON.stringify(evento.payload_json);
  assert.ok(!/@/.test(json), `e-mail no evento: ${json}`);
  assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(json) && !json.includes('11144477735'), `CPF no evento: ${json}`);
  for (const campo of CAMPOS_PROIBIDOS) assert.ok(!(campo in evento.payload_json), `campo proibido ${campo}`);
}

module.exports = { SEIS_RUN_COMPLETED, eventos, chaves, abrirRun, assertSemPii };
