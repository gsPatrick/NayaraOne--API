'use strict';

// M9-D026 — NumberAuditor: todo número, data, identificador e marcador do texto final precisa casar com o numbersPayload
// (read model) ou com um dado conhecido das fontes. Sobra de número sem origem reprova a resposta. Aritmética exata (BigInt).

const { extractEntities, entityKeys, withYears } = require('./numbers/textEntities');
const { sameNumber } = require('./numbers/decimalText');
const { refsOf, isPayloadItem } = require('./numbers/placeholders');
const { splitSentences, markersOf } = require('./grounding/sentences');

function knownKeysOf(numbersPayload, knownTexts) {
  const base = [...(knownTexts || [])];
  for (const item of numbersPayload) {
    if (item.asOf) base.push(String(item.asOf).slice(0, 10));
    if (item.source) base.push(String(item.source));
  }
  return withYears(new Set(base.flatMap((t) => [...entityKeys(t)])));
}

const unitFits = (entityUnit, itemUnit) => !entityUnit || entityUnit === itemUnit;

/**
 * Audita um texto. `numbersPayload`: itens do read model. `knownTexts`: textos de onde vêm datas e identificadores conhecidos
 * (trechos das fontes, ids). `sourceCount`: quantos marcadores [n] existem. Devolve { ok, violations: [{ raw, kind, reason }] }.
 */
function auditNumbers({ text, numbersPayload = [], knownTexts = [], sourceCount = null }) {
  const payload = numbersPayload.filter(isPayloadItem);
  const known = knownKeysOf(payload, knownTexts);
  const violations = [];
  for (const ref of refsOf(text)) {
    if (!payload.some((i) => i.ref === ref)) violations.push({ raw: `{{num:${ref}}}`, kind: 'ref', reason: 'PLACEHOLDER_WITHOUT_ITEM' });
  }
  if (sourceCount !== null) {
    for (const n of markersOf(text)) if (n < 1 || n > sourceCount) violations.push({ raw: `[${n}]`, kind: 'marker', reason: 'MARKER_WITHOUT_SOURCE' });
  }
  for (const e of extractEntities(text)) {
    if (e.kind === 'n') {
      if (!payload.some((i) => sameNumber(i.value, e.key) && unitFits(e.unit, i.unit))) violations.push({ raw: e.raw, kind: 'number', reason: 'NUMBER_WITHOUT_ORIGIN' });
    } else if (!known.has(`${e.kind}:${e.key}`)) {
      violations.push({ raw: e.raw, kind: e.kind === 'd' ? 'date' : e.kind === 'y' ? 'year' : 'id', reason: 'TOKEN_NOT_KNOWN' });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Só as frases cujos números todos têm origem (a "versão com os números verificados"). */
function keepVerifiedSentences(text, context) {
  const kept = splitSentences(text).filter((s) => auditNumbers({ ...context, text: s }).ok);
  return kept.join(/\n/.test(text) ? '\n' : ' ');
}

module.exports = { auditNumbers, keepVerifiedSentences };
