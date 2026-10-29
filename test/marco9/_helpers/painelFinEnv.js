'use strict';

// Apoio dos testes do painel Financeiro do BI (M9-D626): publica os KPIs financeiros para a empresa de teste e grava os snapshots da data-base (ver painelKitEnv).
const kit = require('./painelKitEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');

const FIN_USER = ['analytics:read', 'finance:read'];
const env = kit.makeEnv({ own: '^fin[.]', publish: (scope, tx) => kpis.ensureFinanceKpisPublished(scope, tx) });

module.exports = { ...env, FIN_USER };
