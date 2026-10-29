'use strict';

// M9-D025 — GroundingValidator (passo 11 do orquestrador). Função pura sobre a resposta, as fontes e a configuração: toda afirmação
// factual precisa de marcador [n] de fonte suficiente que contenha o dado; o resto sai da resposta; sem base, a resposta é a
// insuficiência do livro (AI-009), nunca um complemento do modelo. Com ia.grounding.bloquear_sem_fonte ligado, a falta de fonte
// vira 422 AI_UNGROUNDED_FACT em vez de insuficiência.

const C = require('./grounding/grounding.constants');
const { ungroundedFact } = require('./grounding/grounding.errors');
const { normalizeSettings } = require('./grounding/groundingSettings');
const { extractEntities } = require('./numbers/textEntities');
const { splitSentences, markersOf } = require('./grounding/sentences');
const { normalizeSource, effectiveRelevance, isEligible, keysOfSource, isExact } = require('./grounding/sourceEligibility');
const { citationOf, formatSnapshot, resolveSnapshot, buildConflictBlock } = require('./citationBuilder');
const { computeConfidence, displayConfidence } = require('./grounding/confidence');
const { isCriticalDeadline } = require('./grounding/criticalDeadline');

const claimEntities = (sentence) => extractEntities(sentence).filter((e) => e.kind !== 'y');
const keyOf = (e) => `${e.kind}:${e.key}`;

/** Avalia cada frase: mantém, ou remove com o motivo (NO_MARKER, BAD_MARKER, NOT_IN_SOURCE). */
function reviewSentences(text, sources, eligible, keys) {
  const kept = [];
  const removed = [];
  let claims = 0;
  for (const sentence of splitSentences(text)) {
    const markers = markersOf(sentence);
    const entities = claimEntities(sentence);
    const isClaim = entities.length > 0;
    if (isClaim) claims += 1;
    const bad = markers.some((n) => !eligible.has(n));
    if (bad) { removed.push({ sentence, reason: 'BAD_MARKER' }); continue; }
    if (isClaim && markers.length === 0) { removed.push({ sentence, reason: 'NO_MARKER' }); continue; }
    if (isClaim) {
      const available = new Set(markers.flatMap((n) => [...keys.get(n)]));
      if (!entities.every((e) => available.has(keyOf(e)))) { removed.push({ sentence, reason: 'NOT_IN_SOURCE' }); continue; }
    }
    kept.push({ sentence, markers, isClaim });
  }
  return { kept, removed, claims, sources };
}

/** `message` troca a frase padrão (prazo sem fonte exata); essa recusa nunca vira 422: o livro manda 200 com a orientação. */
function insufficiency({ consulted, missing, settings, factual, reason, message }) {
  if (settings.bloquearSemFonte && !message) throw ungroundedFact();
  const linhas = [message || C.MENSAGEM_INSUFICIENCIA];
  if (consulted.length) linhas.push(`Fontes consultadas: ${consulted.join('; ')}.`);
  if (missing) linhas.push(missing);
  return {
    factual, groundingStatus: 'INSUFFICIENT_SOURCES', answer: linhas.join('\n'), sources: [], consulted, snapshotAt: null,
    snapshotAtLocal: null, confidence: '0.0000', confidenceLabel: displayConfidence('0.0000'), requiresHumanConfirmation: false,
    confirmationRequest: null, removedClaims: 0, insufficiencyReason: reason, notices: [],
  };
}

/**
 * input: { answerText, taskType, critical?, sources: [...], snapshotAt?, conflicts?: [{ label, versions: [{ ref, title, version, effectiveFrom, value }] }] }
 * settings: objeto de groundingSettings (relevanciaMinima, bloquearSemFonte, pesoRelevancia, tarefasNaoFactuais, termosCriticos).
 */
function validateGrounding(input, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const text = String((input && input.answerText) || '');
  const sources = ((input && input.sources) || []).map(normalizeSource);
  const consulted = sources.map((s) => s.title).filter(Boolean);
  const nonFactualTask = settings.tarefasNaoFactuais.includes(String(input.taskType || '').toLowerCase());
  const hasEntities = claimEntities(text).length > 0;
  if (nonFactualTask && !hasEntities) {
    return {
      factual: false, groundingStatus: 'NOT_APPLICABLE', answer: text, sources: [], consulted: [], snapshotAt: null, snapshotAtLocal: null,
      confidence: null, confidenceLabel: null, requiresHumanConfirmation: false, confirmationRequest: null, removedClaims: 0, notices: [],
    };
  }
  const eligible = new Map(sources.filter((s) => isEligible(s, settings)).map((s) => [s.ref, s]));
  if (eligible.size === 0) {
    return insufficiency({ consulted, settings, factual: true, reason: 'NO_SUFFICIENT_SOURCE', missing: 'Faltou uma fonte autorizada, vigente e relevante sobre o assunto.' });
  }
  const keys = new Map([...eligible].map(([ref, s]) => [ref, keysOfSource(s)]));
  const review = reviewSentences(text, sources, eligible, keys);
  const citedRefs = new Set(review.kept.flatMap((k) => k.markers));
  if (review.kept.length === 0 || citedRefs.size === 0) {
    return insufficiency({
      consulted, settings, factual: true, reason: review.removed.length ? 'CLAIMS_WITHOUT_SOURCE' : 'NO_CITATION',
      missing: review.removed.length ? `Faltou fonte para ${review.removed.length} afirmação(ões) da resposta.` : 'A resposta não cita nenhuma fonte.',
    });
  }

  let answer = review.kept.map((k) => k.sentence).join(/\n/.test(text) ? '\n' : ' ');
  const cited = [...citedRefs].sort((a, b) => a - b).map((ref) => eligible.get(ref));
  const notices = [];
  let status = 'GROUNDED';
  const conflicts = (input.conflicts || []).filter((c) => c && Array.isArray(c.versions) && c.versions.length > 1);
  if (conflicts.length) { status = 'CONFLICTING_SOURCES'; answer = `${answer}\n\n${buildConflictBlock(conflicts)}`; }

  let requiresHumanConfirmation = false;
  let confirmationRequest = null;
  if (isCriticalDeadline(text, settings, input.critical)) {
    const exact = cited.filter(isExact);
    if (exact.length === 0) {
      return insufficiency({ consulted, settings, factual: true, reason: 'NO_EXACT_SOURCE', missing: null, message: C.MENSAGEM_PRAZO_SEM_FONTE_EXATA });
    }
    requiresHumanConfirmation = true;
    answer = `${answer}\n\n${C.MENSAGEM_CONFIRMACAO_HUMANA}`;
    notices.push('CRITICAL_DEADLINE');
    confirmationRequest = { sourceRefs: exact.map((s) => s.ref), contractRef: exact[0].sourceRef, title: exact[0].title, version: exact[0].version, clause: exact[0].clause };
  }

  const confidence = computeConfidence({
    relevances: cited.map(effectiveRelevance), claims: review.claims, accepted: review.kept.filter((k) => k.isClaim).length, weight: settings.pesoRelevancia,
  });
  const snapshot = resolveSnapshot(input.snapshotAt, cited);
  return {
    factual: true, groundingStatus: status, answer, sources: cited.map((s) => citationOf(s, s.ref)), consulted,
    snapshotAt: snapshot ? snapshot.toISOString() : null, snapshotAtLocal: formatSnapshot(snapshot), confidence,
    confidenceLabel: displayConfidence(confidence), requiresHumanConfirmation, confirmationRequest, removedClaims: review.removed.length, notices,
  };
}

module.exports = { validateGrounding };
