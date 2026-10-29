'use strict';

/** Constantes da avaliação da NAY (M9-D032). Valores do livro (§13, AI-015); o que varia está em evaluations.settings.js. */
const SUITES = Object.freeze(['GOLDEN', 'ADVERSARIAL', 'ALL']);
const STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR']);
const FINAL_STATUSES = Object.freeze(['PASSED', 'FAILED', 'ERROR']);
const CATEGORIES = Object.freeze(['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION', 'COST', 'LATENCY']);

/** Categorias medidas em cada suíte. A suíte ALL mede as sete. */
const SUITE_CATEGORIES = Object.freeze({
  GOLDEN: Object.freeze(['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY']),
  ADVERSARIAL: Object.freeze(['PERMISSIONS', 'INJECTION']),
  ALL: CATEGORIES,
});

/** Categorias de segurança: o livro aceita zero falha (princípios constitucionais). */
const ZERO_FAILURE = Object.freeze(['HALLUCINATION', 'PERMISSIONS', 'INJECTION']);

/** Agentes de alto impacto pelo livro (sem pagar, sem decisão jurídica final, sem decisão de crédito); soma-se qualquer agente com tool HIGH/CRITICAL. */
const HIGH_IMPACT_AGENTS = Object.freeze(['NAY_FINANCEIRA', 'NAY_JURIDICA', 'NAY_CORRESPONDENTE']);

const SANDBOX_PROVIDER = 'ai-sandbox';
const NOTE_MAX = 1000;
const COMMENT_MAX = 500;
const EVENTS = Object.freeze({ finished: 'ai.evaluation.finished', homologated: 'ai.evaluation.homologated', feedback: 'ai.feedback.recorded' });

module.exports = {
  SUITES, STATUSES, FINAL_STATUSES, CATEGORIES, SUITE_CATEGORIES, ZERO_FAILURE, HIGH_IMPACT_AGENTS, SANDBOX_PROVIDER, NOTE_MAX, COMMENT_MAX, EVENTS,
};
