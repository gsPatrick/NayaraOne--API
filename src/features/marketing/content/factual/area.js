'use strict';

const { NUM, parseBR } = require('./text');
const { mismatchOrMissing } = require('./finding');

const AREA_FIELDS = Object.freeze(['areaUtilM2', 'areaTotalM2']);
const AREA = new RegExp(`(?<![\\d.,])${NUM}\\s*(?:m\\s*²|m2(?!\\d)|m\\s*\\^\\s*2|metros?\\s+quadrados?)`, 'g');

/** Área em m²: `120 m²`, `120m2`, `120 metros quadrados`. Vale a útil ou a total, dentro da tolerância do parâmetro. */
function checkArea(doc, facts, options) {
  const known = AREA_FIELDS.map((f) => facts[f]).filter((v) => v !== null && v !== undefined && v !== '').map(Number);
  const findings = [];
  for (const { m, start, end } of doc.matches(AREA)) {
    const found = parseBR(m[1]);
    doc.mask(start, end);
    if (known.some((area) => Math.abs(area - found) <= options.toleranciaAreaM2 + 1e-9)) continue;
    findings.push(mismatchOrMissing({ kind: 'AREA', claim: doc.slice(start, end), expected: known, found, hasData: known.length > 0, label: 'a área' }));
  }
  return findings;
}

module.exports = { checkArea };
