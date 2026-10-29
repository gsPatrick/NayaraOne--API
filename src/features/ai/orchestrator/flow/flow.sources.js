'use strict';

const { screenUserInput } = require('../injectionScreen');
const { loadInjectionLimits } = require('../injectionDetector');
const { loadGroundingSettings } = require('../grounding');
const { semAcento } = require('../numbers/decimalText');
const runs = require('../runs');
const { executionCeiling, providerPolicy } = require('./flow.retrieve');
const { memorySources } = require('./flow.memory');

const AVISO_RESTRITO = 'Parte do conteúdo restrito não foi usada.';
const CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

/** Tarefa factual busca fontes sempre; as não factuais (parâmetro `ia.grounding.tarefas_nao_factuais`) dispensam a busca. */
async function needsSources(state) {
  const settings = await loadGroundingSettings(state.ctx, state.transaction);
  return !settings.tarefasNaoFactuais.includes(semAcento(state.parsed.taskType).toLowerCase());
}

/** Fonte recuperada -> forma interna do run. Classe desconhecida conta como RESTRICTED (falha fechada). */
function normalizeSource(raw) {
  const classification = CLASSES.includes(raw.classification) ? raw.classification : 'RESTRICTED';
  return {
    sourceType: raw.sourceType || 'KNOWLEDGE_ENTRY',
    sourceRef: raw.sourceRef || raw.id || null,
    sourceVersion: raw.sourceVersion || raw.version || null,
    title: raw.title || raw.sourceRef || null,
    clause: raw.clause || null,
    text: String(raw.text ?? raw.excerpt ?? ''),
    values: Array.isArray(raw.values) ? raw.values.map(String) : [],
    classification,
    effectiveFrom: raw.effectiveFrom || null,
    effectiveUntil: raw.effectiveUntil || null,
    relevanceScore: raw.relevanceScore === undefined ? null : raw.relevanceScore,
    statusAtRetrieval: raw.statusAtRetrieval || raw.status || 'VIGENTE',
    contentHash: raw.contentHash || null,
    longDocument: raw.longDocument === true,
    origin: raw.origin || null,
    persisted: raw.persisted === true,
    retrievedAt: raw.retrievedAt || new Date(),
    usedInAnswer: true,
  };
}

/**
 * Passo 4: triagem da entrada do usuário (D021: antes de qualquer busca; override ou exfiltração é 422 AI_INJECTION_BLOCKED e o run
 * fica BLOCKED) e busca das fontes AUTORIZADAS (D023, só o que o ator pode ver, vigente, D024). O retriever é injetado
 * (`deps.retrieve`, padrão: o índice do RAG por `RetrievalService.search`, M9-D023); sem ele a tarefa segue só com o que as ferramentas devolverem. Conteúdo RESTRICTED sem `ai:restricted` não entra.
 */
async function fetchSources(state) {
  const limits = await loadInjectionLimits(state.ctx, state.transaction);
  state.injectionLimits = limits;
  await screenUserInput(state.parsed.input, { limits, ctx: state.ctx, runId: state.runId, transaction: state.transaction });
  state.execution = await executionCeiling({ registry: state.deps.registry, ctx: state.ctx, agent: state.agent, decision: state.decision, transaction: state.transaction });
  const policy = await providerPolicy(state.deps.registry, state.ctx, state.decision && state.decision.provider, state.transaction);
  state.sources.push(...(await memorySources(state, policy)));
  if (!(await needsSources(state)) || typeof state.deps.retrieve !== 'function') return state.sources;
  const found = await state.deps.retrieve({
    ctx: state.ctx, execCtx: state.execCtx, agent: state.agent, taskType: state.parsed.taskType, input: state.parsed.input, purpose: state.parsed.purpose,
    runId: state.runId, execution: state.execution, decision: state.decision, transaction: state.transaction,
  });
  const canSeeRestricted = (state.ctx.permissions || []).includes('ai:restricted');
  const all = (found || []).map(normalizeSource);
  const allowed = all.filter((s) => s.classification !== 'RESTRICTED' || canSeeRestricted);
  if (allowed.length < all.length) state.notices.push(AVISO_RESTRITO);
  state.sources.push(...allowed);
  return allowed;
}

/** Passo 10 (parte das fontes): grava no run as fontes que entraram no contexto, com o trecho curto e redigido (ai.ai_sources). */
async function persistSources(state) {
  for (const [index, s] of state.sources.entries()) {
    if (s.persisted) continue;
    await runs.recordSource(state.ctx, state.runId, {
      sourceType: s.sourceType, sourceRef: s.sourceRef || `fonte-${index + 1}`, sourceVersion: s.sourceVersion, excerpt: s.text, classification: s.classification,
      effectiveFrom: s.effectiveFrom, effectiveUntil: s.effectiveUntil, retrievedAt: s.retrievedAt, relevanceScore: s.relevanceScore,
      usedInAnswer: s.usedInAnswer, statusAtRetrieval: s.statusAtRetrieval, contentHash: s.contentHash,
    }, state.transaction);
    s.persisted = true;
  }
}

module.exports = { fetchSources, persistSources, normalizeSource, needsSources, AVISO_RESTRITO };
