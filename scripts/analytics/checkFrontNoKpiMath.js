'use strict';

/**
 * M9-D614 regra 1 — o Front de BI não calcula KPI: reprova soma/conta sobre campo de métrica, Math.round sobre valor de KPI e import de
 * fórmula. O componente só formata (Intl.NumberFormat). Sai com código 1 e lista arquivo:linha. Sem flag para desligar.
 */
const { checkRule1 } = require('./guardrails/rule1.frontNoKpiMath');
const { formatViolation } = require('./guardrails');
const { FRONT_ROOT } = require('./guardrails/files');

const { scanned, violations } = checkRule1(FRONT_ROOT);
if (violations.length) {
  violations.forEach((v) => console.error(formatViolation(v)));
  process.exit(1);
}
console.log(`OK: ${scanned} arquivo(s) de BI do Front sem cálculo de KPI.`);
