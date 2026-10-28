'use strict';

/**
 * M9-D603 (3.4) — varredura estática do Front: tela de BI não calcula KPI. Reprova, em arquivo de tela de BI,
 * linha que mistura palavra de KPI (kpi, métrica, indicador, snapshot, valueNumeric) com soma de lista
 * (`.reduce(`, `sum(`) ou conta aritmética (`+ - * /` entre operandos). Formatar (toLocaleString, Intl) é livre.
 */
const { listBiSources } = require('./frontReadOnlyScan');

const KPI_WORD = /kpi|metric|m[eé]trica|indicador|snapshot|valueNumeric/i;
const AGGREGATE = /\.reduce\s*\(|\bsum\s*\(|\bMath\.(?:sum|round\s*\([^)]*[*/])/;
const ARITHMETIC = /[\w)\]]\s+[*/]\s+[\w(]|[\w)\]]\s+[+-]\s+[\w(]/;

function stripNoise(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\{\/\*.*?\*\/\}|\/\*.*?\*\//g, '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
}

function scanFrontForKpiCalculation(frontRoot) {
  const violations = [];
  const sources = listBiSources(frontRoot);
  for (const { relative, text } of sources) {
    text.split('\n').forEach((raw, i) => {
      const line = stripNoise(raw);
      if (!KPI_WORD.test(line)) return;
      if (AGGREGATE.test(line)) violations.push({ file: relative, line: i + 1, rule: 'soma de lista de KPI' });
      else if (ARITHMETIC.test(line)) violations.push({ file: relative, line: i + 1, rule: 'conta aritmética sobre KPI' });
    });
  }
  return { scanned: sources.length, violations };
}

module.exports = { scanFrontForKpiCalculation };
