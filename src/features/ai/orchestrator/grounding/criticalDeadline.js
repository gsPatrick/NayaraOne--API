'use strict';

// Contrato e prazo crítico (Caderno §10): fonte exata + "Confirmação humana necessária antes de agir" + recomendação dirigida.

const { semAcento } = require('../numbers/decimalText');

/** A resposta trata de prazo legal, vencimento, multa, rescisão ou obrigação? (termos em ia.grounding.termos_criticos.) */
function isCriticalDeadline(answerText, settings, explicit = false) {
  if (explicit === true) return true;
  const texto = semAcento(answerText);
  return settings.termosCriticos.some((termo) => termo && texto.includes(termo));
}

module.exports = { isCriticalDeadline };
