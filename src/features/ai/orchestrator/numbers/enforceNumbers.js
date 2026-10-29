'use strict';

// M9-D026 — política do passo 11: texto com número sem origem é regerado UMA vez; persistindo, devolve só as frases com
// números verificados (numbersFromReadModelOnly = true); se nada sobrar, 422 AI_NUMBER_NOT_FROM_SOURCE.

const { auditNumbers, keepVerifiedSentences } = require('../numberAuditor');
const { renderPlaceholders } = require('./placeholders');
const { numberNotFromSource } = require('./numbers.errors');

async function enforceNumbers({ text, numbersPayload = [], knownTexts = [], sourceCount = null, regenerate = null }) {
  const context = { numbersPayload, knownTexts, sourceCount };
  const first = auditNumbers({ ...context, text });
  if (first.ok) return { text: renderPlaceholders(text, numbersPayload), attempts: 1, regenerated: false, numbersFromReadModelOnly: false, violations: [] };

  let last = text;
  let audit = first;
  let attempts = 1;
  if (typeof regenerate === 'function') {
    last = String(await regenerate({ violations: first.violations, attempt: 2 }));
    attempts = 2;
    audit = auditNumbers({ ...context, text: last });
    if (audit.ok) return { text: renderPlaceholders(last, numbersPayload), attempts, regenerated: true, numbersFromReadModelOnly: false, violations: first.violations };
  }
  const verified = keepVerifiedSentences(last, context);
  if (!verified.trim()) throw numberNotFromSource({ violations: audit.violations.map((v) => ({ kind: v.kind, reason: v.reason })) });
  return { text: renderPlaceholders(verified, numbersPayload), attempts, regenerated: attempts === 2, numbersFromReadModelOnly: true, violations: audit.violations };
}

module.exports = { enforceNumbers };
