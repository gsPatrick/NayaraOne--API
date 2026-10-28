'use strict';

const crypto = require('node:crypto');

/**
 * M9-D405 — Carimbo da fonte de um conteúdo: o que a fonte dizia no momento da geração. Os fatos vêm do read model público já
 * sanitizado (M9-D403); o hash é do JSON canônico (chaves ordenadas), então a mesma informação sempre dá o mesmo hash.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value === undefined ? null : value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** SHA-256 dos fatos (regra 1: serve de versão quando a fonte não tem contador e também detecta mudança que o contador não vê). */
function hashFacts(facts) {
  return sha256(canonicalJson(facts));
}

/** Fonte desatualizada: a versão da fonte mudou OU o conteúdo público da fonte mudou (hash dos fatos). */
function isSourceChanged({ storedVersion, storedFactsHash }, current) {
  const versionChanged = storedVersion !== null && storedVersion !== undefined && current.version !== null && current.version !== undefined
    && Number(storedVersion) !== Number(current.version);
  const hashChanged = Boolean(storedFactsHash) && storedFactsHash !== hashFacts(current.facts);
  return versionChanged || hashChanged;
}

module.exports = { canonicalJson, sha256, hashFacts, isSourceChanged };
