'use strict';

/**
 * Conflito entre fontes vigentes (M9-D024). Entradas: fontes com os fatos que declaram (`facts: [{ key, raw, value }]`, de facts.js).
 * Duas fontes DISTINTAS (outro tipo ou outra origem) que declaram a mesma chave com valores diferentes divergem; várias versões da
 * mesma origem nunca divergem entre si (a mais nova substitui as anteriores, SUPERSEDED, e só ela é vigente). A detecção nunca
 * escolhe um lado: devolve cada fonte com versão, vigência e valor, no formato que o GroundingValidator (D025) apresenta.
 * detectConflicts(sources) => [{ label, factKey, versions: [{ ref, title, version, effectiveFrom, effectiveUntil, value, sourceType, sourceRef }] }]
 */
const sourceKeyOf = (s) => `${s.sourceType}:${s.sourceRef}`;

function detectConflicts(sources) {
  const byFact = new Map();
  for (const [index, s] of (sources || []).entries()) {
    for (const fact of (s && s.facts) || []) {
      if (!fact || !fact.key || !fact.value) continue;
      const perSource = byFact.get(fact.key) || new Map();
      const k = sourceKeyOf(s);
      if (!perSource.has(k)) perSource.set(k, { s, index, fact });
      byFact.set(fact.key, perSource);
    }
  }
  const conflicts = [];
  for (const [key, perSource] of byFact) {
    const entries = [...perSource.values()];
    if (new Set(entries.map((e) => e.fact.value)).size < 2) continue;
    conflicts.push({
      label: key, factKey: key,
      versions: entries.map(({ s, index, fact }) => ({
        ref: s.ref === undefined ? index + 1 : s.ref, title: s.title || null, version: s.sourceVersion === undefined ? null : s.sourceVersion,
        effectiveFrom: s.effectiveFrom || null, effectiveUntil: s.effectiveUntil || null, value: fact.raw, sourceType: s.sourceType, sourceRef: s.sourceRef,
      })),
    });
  }
  return conflicts.sort((a, b) => (a.factKey < b.factKey ? -1 : 1));
}

module.exports = { detectConflicts, sourceKeyOf };
