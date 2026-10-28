'use strict';

/**
 * M9-D406 — Porta do validador factual. O validador completo (preço, área, quartos, endereço, características, números
 * inexplicáveis, injeção de prompt) é da M9-D407, que o registra aqui com registerFactualValidator. Enquanto isso, o pipeline usa
 * a base abaixo (preço e quartos), que já impede o erro mais grave: texto com número diferente do read model.
 * Contrato: (text, facts) -> { ok, findings: [{kind, claim, expected, found, severity: 'BLOCK'}] }.
 */
const WORD_NUMBERS = Object.freeze({ um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8 });
const PRICE_FIELDS = ['precoVenda', 'precoLocacao', 'precoAnterior', 'condominio', 'iptu'];

function toCents(raw, suffix) {
  const clean = raw.replace(/\./g, '').replace(',', '.');
  const base = Number(clean);
  if (!Number.isFinite(base)) return null;
  const factor = suffix ? 1000 : 1;
  return Math.round(base * factor * 100);
}

function priceFindings(text, facts) {
  const allowed = new Set(PRICE_FIELDS.map((f) => facts[f]).filter((v) => v !== null && v !== undefined).map((v) => Math.round(Number(v) * 100)));
  const findings = [];
  for (const m of text.matchAll(/R\$\s*([\d.]+(?:,\d{1,2})?)\s*(mil|k)?\b/gi)) {
    const cents = toCents(m[1], m[2]);
    if (cents !== null && !allowed.has(cents)) {
      findings.push({ kind: 'PRICE', claim: m[0].trim(), expected: [...allowed].map((c) => c / 100), found: cents / 100, severity: 'BLOCK' });
    }
  }
  return findings;
}

function roomsFindings(text, facts) {
  const findings = [];
  for (const m of text.matchAll(/\b(\d{1,2}|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito)\s+quartos?\b/gi)) {
    const found = /^\d/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1].toLowerCase()];
    if (found !== facts.quartos) findings.push({ kind: 'ROOMS', claim: m[0], expected: facts.quartos === undefined ? null : facts.quartos, found, severity: 'BLOCK' });
  }
  return findings;
}

function baseValidator(text, facts) {
  const safe = facts && typeof facts === 'object' ? facts : {};
  const findings = [...priceFindings(String(text), safe), ...roomsFindings(String(text), safe)];
  return { ok: findings.length === 0, findings };
}

let validator = baseValidator;

function registerFactualValidator(fn) {
  if (typeof fn !== 'function') throw new TypeError('O validador factual deve ser uma função.');
  validator = fn;
}

function resetFactualValidator() {
  validator = baseValidator;
}

/** validateAgainstFacts(text, facts) — Guia §6, função 3. */
function validateAgainstFacts(text, facts) {
  return validator(text, facts);
}

module.exports = { validateAgainstFacts, registerFactualValidator, resetFactualValidator, baseValidator };
