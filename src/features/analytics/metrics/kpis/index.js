'use strict';

// M9-D624 — KPIs do Financeiro no BI: definição no registry, cálculo a partir do read model e gravação do snapshot a cada refresh.
const { KPI_DEFINITIONS } = require('./finance.definitions');
const { ensureFinanceKpisPublished } = require('./finance.register');
const { materializeFinanceKpis, financeKpiCorrections } = require('./finance.materialize');
const listener = require('./finance.listener');

module.exports = { KPI_DEFINITIONS, ensureFinanceKpisPublished, materializeFinanceKpis, financeKpiCorrections, installFinanceKpis: listener.install };
