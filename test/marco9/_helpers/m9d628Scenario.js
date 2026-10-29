'use strict';

// Cenário completo da M9-D628: grava as fontes de uma empresa e devolve os eventos reais que atualizam os read models que têm evento. Os demais (disponibilidade, filas,
// freshness e falhas de autenticação) dependem do relógio: entram pela passada agendada (`bi.runSchedule`).
const env628 = require('./m9d628Env');
const plataforma = require('./m9d628Plataforma');
const integracoes = require('./m9d628Integracoes');
const ia = require('./m9d628Ia');

async function seedAll(env, t) {
  await plataforma.sondas(env);
  await plataforma.filas(env, t);
  await plataforma.atualizacoes(env, t);
  const conns = await integracoes.integracoes(env, t);
  await integracoes.autenticacao(env, t, conns);
  await integracoes.bloqueios(env, t);
  const runs = await ia.ia(env, t);
  return { conns, runs };
}

/** [tipo do evento, payload, read models que ele atualiza]. */
function eventsOf(ids) {
  return [
    ['integration.dispatch.failed', { id: ids.conns.a }, ['rm_tech_integrations', 'rm_tech_blocked_events']],
    ['automation.run.blocked', { id: env628.uuid(), runId: env628.uuid() }, ['rm_tech_blocked_events']],
    ['ai.run.completed', { id: ids.runs.r1, runId: ids.runs.r1 }, ['rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls']],
    ['ai.evaluation.finished', { id: ids.runs.evaluation }, ['rm_ai_quality']],
  ];
}

async function applyAll(env, t, ids) {
  for (const [type, payload] of eventsOf(ids)) await env628.apply(t, env628.makeEvent(t, type, payload));
  await env628.runSchedule(t, env628.NOW);
}

module.exports = { MODELS: env628.MODELS, seedAll, eventsOf, applyAll };
