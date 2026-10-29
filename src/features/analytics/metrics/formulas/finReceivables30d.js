'use strict';

/** M9-D621 — KPI fin.receivables_30d: janela de 30 dias (hoje até hoje+29, cumulativa), próprio e pendente, em reais. Regra em _finWindow.js. */
const { windowFormula } = require('./_finWindow');

module.exports = windowFormula({ id: 'fin.receivables_30d', windowDays: 30, caseAmounts: ['65000.00', '65000.00', '10.004', '10.00'] });
