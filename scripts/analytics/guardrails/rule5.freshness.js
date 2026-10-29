'use strict';

/**
 * Regra 5 — "Não mostrar dado stale como atual". API: todo código que monta resposta de métrica (objeto com `metricCode`, `value` e
 * `valueNature`) devolve `freshness`. Front: todo componente de card/tile de BI recebe `freshness` e falha no render se ela faltar.
 * O cálculo do status de frescor é da M9-D609; aqui só o guarda de presença.
 */
const fs = require('node:fs');
const path = require('node:path');
const { listBiSources } = require('../../lib/frontReadOnlyScan');
const { API_ROOT, listFiles, violation } = require('./files');

const CARD_FILE = /(?:Card|Tile|Kpi)[A-Za-z0-9]*\.(?:jsx?|tsx?)$/;
const REQUIRES_FRESHNESS = /(?:throw\b[^\n]*freshness|!\s*freshness\b|freshness\s*(?:==|===)\s*(?:null|undefined)|freshness\s*\?\?\s*(?:null|undefined))/;

function isMetricResponse(text) {
  return /\bmetricCode\s*:/.test(text) && /\bvalue\s*:/.test(text) && /\bvalueNature\s*:/.test(text);
}

function checkRule5(root = API_ROOT, frontRoot = null) {
  const out = [];
  const src = path.join(root, 'src', 'features', 'analytics');
  for (const file of listFiles(src, /\.js$/)) {
    const text = fs.readFileSync(file, 'utf8');
    if (isMetricResponse(text) && !/\bfreshness\b/.test(text)) out.push(violation(5, path.relative(root, file), 'Resposta de métrica sem freshness (dado velho passaria por atual).'));
  }
  if (frontRoot) {
    for (const { relative, text } of listBiSources(frontRoot).filter((s) => CARD_FILE.test(s.relative))) {
      if (!REQUIRES_FRESHNESS.test(text)) out.push(violation(5, relative, 'Componente de card de BI não exige freshness (deve falhar no render se ausente).'));
    }
  }
  return { scanned: 0, violations: out };
}

module.exports = { checkRule5 };
