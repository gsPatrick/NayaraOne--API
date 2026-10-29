'use strict';

const { fold, present } = require('./text');
const { finding, mismatchOrMissing } = require('./finding');

const TYPE = '(?:[Rr]ua|[Aa]venida|[Aa]v\\.?|[Aa]lameda|[Tt]ravessa|[Rr]odovia|[Ee]strada|[Pp]raça|[Ll]argo)';
const NAME = "(?:d[aeo]s?\\s+)?\\p{Lu}[\\p{L}'’-]*(?:\\s+(?:d[aeo]s?\\s+)?\\p{Lu}[\\p{L}'’-]*)*";
const STREET = new RegExp(`(?<![\\p{L}])(${TYPE})\\s+(${NAME})(?:\\s*,\\s*(?:n[ºo°.]*\\s*)?(\\d{1,5})(?!\\d)|\\s+n[ºo°]\\.?\\s*(\\d{1,5})(?!\\d))?`, 'gu');
const DISTRICT = new RegExp(`(?<![\\p{L}])[Bb]airro\\s+(${NAME})`, 'gu');
const ZIP = /(?<!\d)\d{5}-?\d{3}(?!\d)/g;

const stripType = (name) => fold(name).replace(/^(rua|avenida|av\.?|alameda|travessa|rodovia|estrada|praca|largo)\s+/, '').trim();
/** O nome citado vale se for o do cadastro (podendo trazer palavras maiúsculas coladas depois, como o início da frase seguinte). */
const sameName = (claimed, allowed) => claimed === allowed || claimed.startsWith(`${allowed} `);

function checkZip(doc) {
  return doc.matches(ZIP).map(({ m, start, end }) => {
    doc.mask(start, end);
    return finding({
      kind: 'ADDRESS', claim: m[0], expected: null, found: m[0], reason: 'MISSING', message: 'O CEP não faz parte dos dados públicos do cadastro: dado inexistente, a IA não inventa.',
    });
  });
}

function checkStreets(doc, facts) {
  const findings = [];
  const allowedStreet = present(facts.logradouro) ? stripType(String(facts.logradouro)) : null;
  for (const { m, start, end } of doc.matches(STREET, doc.maskedRaw())) {
    const number = m[3] || m[4] || null;
    const claimed = stripType(m[2]);
    doc.mask(start, end);
    const claim = doc.slice(start, end);
    if (!allowedStreet || !sameName(claimed, allowedStreet)) {
      findings.push(mismatchOrMissing({ kind: 'ADDRESS', claim, expected: present(facts.logradouro) ? String(facts.logradouro) : null, found: m[2], hasData: Boolean(allowedStreet), label: 'a rua (a política de endereço da empresa pode ocultá-la)' }));
    } else if (number && String(facts.numeroEndereco || '').trim() !== number) {
      findings.push(mismatchOrMissing({ kind: 'ADDRESS', claim, expected: present(facts.numeroEndereco) ? String(facts.numeroEndereco) : null, found: number, hasData: present(facts.numeroEndereco), label: 'o número do endereço' }));
    }
  }
  return findings;
}

function checkDistrict(doc, facts) {
  const findings = [];
  const allowed = present(facts.bairro) ? fold(String(facts.bairro)).trim() : null;
  for (const { m, start, end } of doc.matches(DISTRICT, doc.maskedRaw())) {
    const claimed = fold(m[1]).trim();
    doc.mask(start, end);
    if (allowed && sameName(claimed, allowed)) continue;
    findings.push(mismatchOrMissing({ kind: 'ADDRESS', claim: doc.slice(start, end), expected: allowed ? String(facts.bairro) : null, found: m[1], hasData: Boolean(allowed), label: 'o bairro' }));
  }
  return findings;
}

/** Endereço: rua e número só se a política de endereço os deixou no cadastro público; CEP nunca; bairro precisa ser o do cadastro. */
function checkAddress(doc, facts) {
  return [...checkZip(doc), ...checkStreets(doc, facts), ...checkDistrict(doc, facts)];
}

module.exports = { checkAddress };
