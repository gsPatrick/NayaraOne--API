'use strict';

const { deterministicAnswer } = require('../numbers');
const E = require('./flow.errors');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Cada origem distinta do `numbersPayload` (o read model) vira uma fonte READ_MODEL exata: "rótulo: valor" por item. */
function sourcesOfPayload(payload, nowMs) {
  const bySource = new Map();
  for (const item of payload) {
    if (!item || typeof item.ref !== 'string') continue;
    const key = item.source || 'read-model';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(item);
  }
  return [...bySource].map(([title, items]) => ({
    sourceType: 'READ_MODEL', sourceRef: title, sourceVersion: null, title, clause: null, text: items.map((i) => `${i.label || i.ref}: ${i.value}`).join('\n'),
    values: items.map((i) => String(i.value)), classification: 'INTERNAL', effectiveFrom: null, effectiveUntil: null, relevanceScore: null, statusAtRetrieval: 'VIGENTE',
    contentHash: null, longDocument: false, retrievedAt: items[0].asOf || new Date(nowMs), usedInAnswer: true,
  }));
}

/**
 * Caminhos sem modelo (RULE e CACHE): a resposta e as fontes vêm do resultado do resolvedor (D012) ou do cache (D015). Contrato do
 * resultado: `{ answer?, numbersPayload?, sources? }` (ou um texto). Sem `answer`, a resposta é montada SÓ de placeholders do
 * `numbersPayload` (o servidor escreve o valor). `calcular_*` sem resultado nenhum é 422 AI_RULE_UNRESOLVED: o modelo nunca calcula.
 */
function presetAnswer(state, decision) {
  const result = decision.path === 'CACHE' ? decision.cacheResult : decision.ruleResult;
  const body = typeof result === 'string' ? { answer: result } : (isPlainObject(result) ? result : {});
  const payload = Array.isArray(body.numbersPayload) ? body.numbersPayload : [];
  const text = typeof body.answer === 'string' ? body.answer : (payload.length ? deterministicAnswer(payload) : null);
  if (text === null) throw E.ruleUnresolved();
  // Acerto de cache: o usuário vê a data real do dado (snapshot_at original), não a do acerto.
  if (decision.path === 'CACHE' && body.snapshotAt) state.parsed = { ...state.parsed, snapshotAt: body.snapshotAt };
  state.numbersPayload.push(...payload);
  // Resposta estruturada e dados da regra que o agente usa depois (ex.: a recomendação da próxima ação, M9-D034).
  state.structured = isPlainObject(body.structured) ? body.structured : null;
  state.ruleMeta = isPlainObject(body.meta) ? body.meta : null;
  for (const s of body.sources || []) {
    state.sources.push({
      sourceType: s.sourceType || 'READ_MODEL', sourceRef: s.sourceRef || null, sourceVersion: s.sourceVersion || null, title: s.title || s.sourceRef || null, clause: s.clause || null,
      text: String(s.text ?? s.excerpt ?? ''), values: Array.isArray(s.values) ? s.values.map(String) : [], classification: s.classification || 'INTERNAL',
      effectiveFrom: s.effectiveFrom || null, effectiveUntil: s.effectiveUntil || null, relevanceScore: s.relevanceScore === undefined ? null : s.relevanceScore,
      statusAtRetrieval: s.statusAtRetrieval || 'VIGENTE', contentHash: s.contentHash || null, longDocument: false, retrievedAt: s.retrievedAt || new Date(state.clock()), usedInAnswer: true,
    });
  }
  if (!state.sources.length && payload.length) state.sources.push(...sourcesOfPayload(payload, state.clock()));
  return text;
}

module.exports = { presetAnswer };
