'use strict';

// M9-D810 §3.3 — área EXEC_KPI (KPIs executivos): os indicadores críticos do registry de métricas do BI que não são de dinheiro, contrato nem comissão.
const { buildForAreas } = require('../kit/paths');
const { AREA } = require('../lineage.constants');

module.exports = { code: 'M9-D810-exec-kpi', build: () => buildForAreas([AREA.EXEC_KPI]) };
