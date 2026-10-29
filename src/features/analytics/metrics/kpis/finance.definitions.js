'use strict';

/**
 * M9-D624 (3.1 e 5) — definição, no Metric Registry, dos KPIs de conciliações pendentes e anomalias abertas do Financeiro. Os 15 campos do livro
 * (M9-D603): fonte rm_finance_health, fórmula versionada no código, dimensões, unidade, owner (parâmetro analytics.owner.fin.<kpi>), política de
 * atualização (evento + agenda de 15 min, M9-D607) e regra de qualidade. Versão 1.
 */
const { readOwner } = require('../../read-models/financeKpi.settings');

const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Financeiro (M9-D708): conciliações e anomalias contadas pelo módulo Financeiro';
const MAX_STALENESS_MINUTES = 15;
const SOURCE_READ_MODEL = 'rm_finance_health'; // a tabela vem da definição, nunca citada solta: a varredura de segurança (M9-D700, R1) só deixa citar a tabela do read model na camada read-models

const RECONCILIATION_DEFINITIONS = Object.freeze([
  {
    metricCode: 'fin.reconciliations_pending', name: 'Conciliações pendentes',
    description: 'Transações bancárias importadas, até o dia-base, ainda sem conciliação: quantidade, soma dos valores absolutos em reais e idade da mais antiga.',
    formulaId: 'fin.reconciliations_pending',
    formulaSemantic: 'Contagem e soma dos valores absolutos das transações bancárias importadas (data de São Paulo até o dia-base) sem conciliação aprovada; idade da mais antiga em dias.',
    dimensions: ['empresa', 'conta bancária', 'faixa de idade (0-2, 3-7, 8+)'], unit: 'COUNT', criticality: 'NORMAL',
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields: ['last_statement_import_date'], allowNull: true },
  },
  {
    metricCode: 'fin.anomalies_open', name: 'Anomalias abertas',
    description: 'Casos de anomalia financeira com status aberto no dia-base, por nível de risco (baixo, médio, alto), com os de risco alto separados.',
    formulaId: 'fin.anomalies_open',
    formulaSemantic: 'Contagem dos casos de anomalia abertos, por nível de risco (BAIXO, MEDIO, ALTO) e por tipo; contagem de risco alto separada; idade do mais antigo.',
    dimensions: ['empresa', 'nível de risco', 'tipo de anomalia'], unit: 'COUNT', criticality: 'NORMAL',
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields: ['open_anomalies_by_risk'], allowNull: true },
  },
]);

// M9-D621: as janelas de contas a pagar e recebíveis entram na mesma publicação e no mesmo cálculo
const KPI_DEFINITIONS = Object.freeze([...RECONCILIATION_DEFINITIONS, ...require('./finance.horizon').DEFINITIONS, ...require('./finance.cash').DEFINITIONS, ...require('./finance.results').DEFINITIONS]);

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return {
    ...def, scopeLevel: 'COMPANY', sourceReadModel: def.sourceReadModel || SOURCE_READ_MODEL, filters: {}, version: 1, validFrom: '2026-01-01', valueNature: def.valueNature || 'ACTUAL',
    ownerRole: (await require('./finance.cash').ownerOf(def.metricCode, scope, transaction)) || await readOwner(def.metricCode, scope, transaction), // M9-D620: owner do caixa tem parâmetro próprio
    refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: MAX_STALENESS_MINUTES },
  };
}

module.exports = { KPI_DEFINITIONS, SOURCE_READ_MODEL, publishInput };
