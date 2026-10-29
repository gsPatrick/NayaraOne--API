'use strict';

/**
 * M9-D614 — os 7 guardas do "Não improvisar" (Guia §14). Cada regra é um arquivo `ruleN.*.js` que devolve `{ scanned, violations }`;
 * `runStaticGuards` roda as que só leem arquivos (1, 2, 3, 5, 6); a 4 (hash da fórmula x banco) e a 7 (rotas x HTTP) precisam de banco
 * e servidor e rodam no teste m9d614 do CI. NÃO existe variável de ambiente, argumento ou flag que desligue um guarda.
 */
const fs = require('node:fs');
const { API_ROOT, FRONT_ROOT } = require('./files');
const { checkRule1 } = require('./rule1.frontNoKpiMath');
const { checkRule2 } = require('./rule2.dashboardOnlyAnalytics');
const { checkRule3 } = require('./rule3.freeCashOwnFunds');
const { checkRule4 } = require('./rule4.formulaCodeHash');
const { checkRule5 } = require('./rule5.freshness');
const { checkRule6 } = require('./rule6.nayNoFreeSql');
const { checkRule7 } = require('./rule7.drilldownExportPermission');

const RULE_TITLES = Object.freeze({
  1: 'Não calcular KPI importante no frontend',
  2: 'Não consultar OLTP pesado a cada dashboard',
  3: 'Não misturar caixa próprio/terceiros',
  4: 'Não mudar fórmula sem versionar',
  5: 'Não mostrar dado stale como atual',
  6: 'Não permitir NAY SQL livre',
  7: 'Não liberar drill-down/export sem permissão',
});

function runStaticGuards({ root = API_ROOT, frontRoot = FRONT_ROOT } = {}) {
  const hasFront = fs.existsSync(frontRoot);
  const { INITIAL_DEFINITIONS } = require('../../../src/features/ai/tools/definitions');
  const results = {
    1: hasFront ? checkRule1(frontRoot) : { scanned: 0, violations: [] },
    2: checkRule2(root),
    3: checkRule3(root),
    5: checkRule5(root, hasFront ? frontRoot : null),
    6: checkRule6(INITIAL_DEFINITIONS),
  };
  return { results, violations: Object.values(results).flatMap((r) => r.violations) };
}

const formatViolation = (v) => `Regra ${v.rule} (${RULE_TITLES[v.rule]}): ${v.file}${v.line ? `:${v.line}` : ''} - ${v.message}`;

module.exports = { RULE_TITLES, runStaticGuards, formatViolation, checkRule1, checkRule2, checkRule3, checkRule4, checkRule5, checkRule6, checkRule7 };
