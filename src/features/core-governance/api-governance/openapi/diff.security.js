'use strict';

const { RULE } = require('./openapi.constants');
const { change } = require('./diff.schema');

const norm = (value) => JSON.stringify(value === undefined ? null : value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const requirement = (doc, operation) => {
  const raw = operation.security !== undefined ? operation.security : doc.security;
  return (Array.isArray(raw) ? raw : []).map((entry) => norm(Object.fromEntries(Object.entries(entry).map(([name, scopes]) => [name, [...scopes].sort()])))).sort();
};

/** Regra 8: o esquema de segurança exigido (ou seus escopos) mudou na operação, ou a definição do esquema mudou de tipo. */
function diffSecurity(baseDoc, candDoc, base, cand, where) {
  const out = [];
  const before = requirement(baseDoc, base.operation);
  const after = requirement(candDoc, cand.operation);
  if (before.join('|') !== after.join('|')) out.push(change(RULE.SECURITY_CHANGED, 8, where, 'esquema ou escopo de segurança exigido mudou'));
  const baseSchemes = (baseDoc.components && baseDoc.components.securitySchemes) || {};
  const candSchemes = (candDoc.components && candDoc.components.securitySchemes) || {};
  for (const [name, scheme] of Object.entries(baseSchemes)) {
    if (candSchemes[name] && norm(candSchemes[name]) !== norm(scheme) && before.some((entry) => entry.includes(`"${name}"`))) out.push(change(RULE.SECURITY_CHANGED, 8, where, `definição do esquema "${name}" mudou`));
  }
  return out;
}

module.exports = { diffSecurity };
