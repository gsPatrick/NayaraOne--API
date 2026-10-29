'use strict';

const { WORD_PATTERN, parseCount, present } = require('./text');
const { mismatchOrMissing } = require('./finding');

/** Substantivo (sem acento) -> campo do read model, tipo de finding e rótulo. Vagas entram como NUMBER; o resto como ROOMS. */
const NOUNS = Object.freeze({
  quarto: { field: 'quartos', kind: 'ROOMS', label: 'a quantidade de quartos' },
  dormitorio: { field: 'quartos', kind: 'ROOMS', label: 'a quantidade de quartos' },
  dorm: { field: 'quartos', kind: 'ROOMS', label: 'a quantidade de quartos' },
  suite: { field: 'suites', kind: 'ROOMS', label: 'a quantidade de suítes' },
  banheiro: { field: 'banheiros', kind: 'ROOMS', label: 'a quantidade de banheiros' },
  vaga: { field: 'vagas', kind: 'NUMBER', label: 'a quantidade de vagas' },
  garagem: { field: 'vagas', kind: 'NUMBER', label: 'a quantidade de vagas' },
});
const COUNT = new RegExp(`(?<![\\w.,])(\\d{1,2}|${WORD_PATTERN})\\s+(quartos?|dormitorios?|dorms?|suites?|banheiros?|vagas?|garagens?)\\b`, 'g');
const nounKey = (noun) => noun.replace(/ens$/, 'em').replace(/s$/, '');

/** Quantidades (quartos, suítes, banheiros, vagas): número ou número por extenso (pt-BR até vinte) seguido do substantivo. */
function checkCounts(doc, facts) {
  const findings = [];
  for (const { m, start, end } of doc.matches(COUNT)) {
    const spec = NOUNS[nounKey(m[2])];
    const found = parseCount(m[1]);
    doc.mask(start, end);
    if (!spec || found === null) continue;
    const has = present(facts[spec.field]);
    if (has && Number(facts[spec.field]) === found) continue;
    findings.push(mismatchOrMissing({ kind: spec.kind, claim: doc.slice(start, end), expected: has ? Number(facts[spec.field]) : null, found, hasData: has, label: spec.label }));
  }
  return findings;
}

module.exports = { checkCounts };
