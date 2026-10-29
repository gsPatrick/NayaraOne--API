'use strict';

const { fold, escapeRe } = require('./text');
const { finding } = require('./finding');

const NEGATION = /(?:\bsem|\bnao\s+(?:tem|possui|ha|conta\s+com|oferece)|\bnenhum[a]?)\s+(?:\S+\s+){0,2}$/;

/** Termos do dicionário, do mais longo para o mais curto, cada um ligado à sua característica. */
function buildTerms(groups) {
  const terms = [];
  for (const [canonical, synonyms] of groups) {
    for (const term of new Set([canonical, ...synonyms])) terms.push({ canonical, term: fold(term).trim() });
  }
  return terms.sort((a, b) => b.term.length - a.term.length);
}

const termRegex = (term) => new RegExp(`(?<![a-z0-9])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'g');

/** As características do cadastro, dobradas, e para cada grupo do dicionário se alguma delas pertence a ele. */
function groupPresence(groups, facts) {
  const listed = (Array.isArray(facts.features) ? facts.features : []).filter((f) => typeof f === 'string').map((f) => fold(f).trim());
  const presence = new Map();
  for (const [canonical, synonyms] of groups) presence.set(canonical, synonyms.some((s) => listed.includes(fold(s).trim())));
  return { presence, listed };
}

/** Características citadas (piscina, varanda...): cada uma precisa estar em features[] do cadastro, pelo dicionário fechado de sinônimos. */
function checkFeatures(doc, facts, options) {
  const { presence, listed } = groupPresence(options.featureGroups, facts);
  const findings = [];
  for (const { canonical, term } of buildTerms(options.featureGroups)) {
    for (const { start, end } of doc.matches(termRegex(term))) {
      const negated = NEGATION.test(doc.work.slice(Math.max(0, start - 40), start));
      doc.mask(start, end);
      const has = presence.get(canonical);
      if (negated && !has) continue;
      if (!negated && has) continue;
      const claim = doc.slice(start, end);
      findings.push(finding({
        kind: 'FEATURE', claim, expected: listed.length ? (facts.features || []) : null, found: canonical,
        reason: listed.length ? 'MISMATCH' : 'MISSING',
        message: negated ? `O texto nega "${canonical}", mas o cadastro lista essa característica.` : `O cadastro não lista "${canonical}": dado inexistente, a IA não inventa.`,
      }));
    }
  }
  return findings;
}

module.exports = { checkFeatures };
