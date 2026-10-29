'use strict';

/**
 * Regra 1 — "Não calcular KPI importante no frontend". Nos arquivos de BI do Front: reprova soma de lista e conta aritmética sobre campo
 * de métrica (varredura da M9-D603), `Math.round` sobre valor de KPI e qualquer import de fórmula. O componente só formata (Intl).
 */
const path = require('node:path');
const { scanFrontForKpiCalculation } = require('../../lib/frontKpiCalcScan');
const { listBiSources } = require('../../lib/frontReadOnlyScan');
const { violation } = require('./files');

const KPI_WORD = /kpi|metric|m[eé]trica|indicador|snapshot|valueNumeric/i;
const FORMULA_IMPORT = /\b(?:import|require)\b[^\n]*(?:metrics\/formulas|\/formulas\/|formulaCatalog|formulas\/money)/;

function checkRule1(frontRoot) {
  const found = scanFrontForKpiCalculation(frontRoot);
  const out = found.violations.map((v) => violation(1, v.file, `Front calcula KPI (${v.rule}).`, v.line));
  for (const { relative, text } of listBiSources(frontRoot)) {
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (FORMULA_IMPORT.test(code)) out.push(violation(1, relative, 'Front importa fórmula de KPI.', i + 1));
      else if (/\bMath\.round\s*\(/.test(code) && KPI_WORD.test(code)) out.push(violation(1, relative, 'Math.round sobre valor de KPI no Front.', i + 1));
    });
  }
  return { scanned: found.scanned, violations: out.map((v) => ({ ...v, file: path.normalize(v.file) })) };
}

module.exports = { checkRule1 };
