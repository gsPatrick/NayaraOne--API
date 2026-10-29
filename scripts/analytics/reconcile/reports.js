'use strict';

/**
 * M9-D708 (3.3) — adaptadores dos relatórios de referência por KPI, injetados em reconcileMetric. O KPI sem adaptador é conferido contra a origem registrada
 * dele (sourceRefs, M9-D611): a lista de contratos ATIVOS, de prazos, o saldo de estoque etc. refeitos direto das tabelas do módulo de origem.
 */
const { FINANCE_REPORTS } = require('./reports.finance');

const REFERENCE_REPORTS = Object.freeze({ ...FINANCE_REPORTS });

module.exports = { REFERENCE_REPORTS };
