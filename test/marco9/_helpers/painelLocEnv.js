'use strict';

// Apoio dos testes do painel Locação do BI (M9-D643): publica os KPIs de locação para a empresa de teste e grava os snapshots da data-base (ver painelKitEnv).
const kit = require('./painelKitEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const base = require('./painelBiEnv');
const { rentalFilterOf } = require('../../../src/features/analytics/metrics/kpis/locacao-prazos/filters');
const { LOCACAO_DEFAULTS, KEYS, parseTypes } = require('../../../src/features/analytics/read-models/locacao.settings');

// Origem do número (sourceRefs) das garantias a vencer, que é CRITICAL: o painel só oferece o detalhe quando o snapshot tem o filtro assinado.
const leaseTypes = parseTypes(LOCACAO_DEFAULTS[KEYS.contractTypes]);
base.FILTERS['rent.guarantees_expiring'] = () => rentalFilterOf('rent.guarantees_expiring', base.AS_OF, { leaseTypes });

const RENT_USER = ['analytics:read', 'legal:read'];
const env = kit.makeEnv({
  own: '^rent[.]',
  publish: async (scope, tx) => {
    await kpis.ensureRentalPortfolioKpisPublished(scope, tx);
    await kpis.ensureRentalDeadlineKpisPublished(scope, tx);
    await kpis.ensureRentalCareKpisPublished(scope, tx);
  },
});

module.exports = { ...env, RENT_USER };
