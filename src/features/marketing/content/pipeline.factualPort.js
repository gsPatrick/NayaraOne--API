'use strict';

const { validateAgainstFacts: fullValidator } = require('./factualValidator');

/**
 * M9-D406/M9-D407 — Porta do validador factual. O validador padrão é o completo da M9-D407 (factualValidator.js: preço, área,
 * quantidades, endereço, características, números inexplicáveis e suspeita de injeção, sem IA); registerFactualValidator troca por
 * outro (usado nos testes). Contrato: (text, facts, options) -> { ok, findings: [{kind, claim, expected, found, severity: 'BLOCK', reason}] }.
 */
let validator = fullValidator;

function registerFactualValidator(fn) {
  if (typeof fn !== 'function') throw new TypeError('O validador factual deve ser uma função.');
  validator = fn;
}

function resetFactualValidator() {
  validator = fullValidator;
}

/** validateAgainstFacts(text, facts, options) — Guia §6, função 3. */
function validateAgainstFacts(text, facts, options) {
  return validator(text, facts, options);
}

module.exports = { validateAgainstFacts, registerFactualValidator, resetFactualValidator };
