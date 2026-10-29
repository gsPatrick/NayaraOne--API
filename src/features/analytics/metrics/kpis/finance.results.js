'use strict';

/**
 * M9-D623 — definição, entradas e parâmetros dos quatro KPIs de resultado do Financeiro: margem por setor, comissões provisionadas, comissões pagas e
 * repasses pendentes ao proprietário. Os 15 campos do livro (M9-D603): fonte (rm_finance_sector_margin para a margem; rm_finance_health para os
 * demais), fórmula versionada no código, dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização (evento + agenda de
 * 15 min, M9-D607) e regra de qualidade. Versão 1. fin.owner_repasses_pending é CRITICAL (dinheiro parado de terceiros, tabela da M9-D712): nasce com
 * drill-down. A margem lê, além da linha do rm_finance_health da data-base, as linhas do rm_finance_sector_margin do mês de competência.
 */
const { sequelize } = require('../../../../models');
const { RESULT_CODES } = require('../../read-models/financeResults.settings');
require('../sourceSpecs.finance.results');

const REFERENCE_REPORT = 'Relatório de resultado do Financeiro (M9-D708): margem por setor, comissões e repasses';
const MAX_STALENESS_MINUTES = 15;
const SECTOR_MODEL = 'rm_finance_sector_margin'; // a tabela vem desta constante, nunca citada solta: a varredura de segurança (M9-D700, R1) só deixa citar `analytics.rm_*` na camada read-models
const NO_CENTER = '00000000-0000-0000-0000-000000000000';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const META = Object.freeze({
  'fin.sector_margin': {
    name: 'Margem por setor', sourceReadModel: SECTOR_MODEL, valueNature: 'ACTUAL', criticality: 'NORMAL', dimensions: ['empresa', 'centro de resultado', 'mês de competência'],
    description: 'Receita, custo e margem (em reais e em %) realizados por centro de resultado no mês de competência da data-base; o valor é a margem total da empresa no mês.',
    formulaSemantic: 'Por centro de resultado: receita = Σ entradas próprias liquidadas da competência; custo = Σ saídas próprias liquidadas da mesma competência; margem = receita − custo; margem % = margem ÷ receita × 100 (2 casas). Sem centro de resultado vai para "Sem setor".',
    requiredFields: ['result_center_id'],
  },
  'fin.commissions_provisioned': {
    name: 'Comissões provisionadas', sourceReadModel: 'rm_finance_health', valueNature: 'PLANNED', criticality: 'NORMAL', dimensions: ['empresa', 'corretor', 'tipo de comissão'],
    description: 'Soma, em reais, das parcelas de comissão com direito reconhecido e ainda não pagas, por corretor e tipo; parcela sem corretor é contada em "Sem corretor".',
    formulaSemantic: 'Σ valor das parcelas PENDING de comissões PENDING ou APPROVED, até o fim do dia-base; natureza PLANNED única e fixa.',
    requiredFields: ['provisioned_commissions_detail'],
  },
  'fin.commissions_paid': {
    name: 'Comissões pagas', sourceReadModel: 'rm_finance_health', valueNature: 'ACTUAL', criticality: 'NORMAL', dimensions: ['empresa', 'corretor', 'mês'],
    description: 'Soma, em reais, das parcelas de comissão quitadas no mês da data-base (calendário de São Paulo), por corretor.',
    formulaSemantic: 'Σ valor das parcelas PAID com data de pagamento (calendário de São Paulo) dentro do mês da data-base.',
    requiredFields: ['paid_commissions_detail'],
  },
  'fin.owner_repasses_pending': {
    name: 'Repasses pendentes ao proprietário', sourceReadModel: 'rm_finance_health', valueNature: 'ACTUAL', criticality: 'CRITICAL', dimensions: ['empresa', 'proprietário', 'imóvel', 'faixa de atraso'],
    description: 'Soma, em reais, dos repasses ao proprietário gerados e ainda não pagos, com a quantidade, a idade média e o que passou do alerta em dias úteis; dinheiro de terceiros.',
    formulaSemantic: 'Σ valor líquido dos repasses PENDING ou APPROVED até o dia-base; contagem e idade média em dias corridos; vencido além de analytics.repasse.dias_alerta dias úteis exposto em details.',
    requiredFields: ['owner_repasses_detail'],
  },
});

const DEFINITIONS = Object.freeze(RESULT_CODES.map((code) => {
  const { requiredFields, ...meta } = META[code];
  return { metricCode: code, formulaId: code, unit: 'BRL', ...meta, dimensions: [...meta.dimensions], qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields, allowNull: true } };
}));

const detail = (row, key) => (row && row[key]) || {};
const orphan = (d) => d.withoutBroker || { count: 0, amount: '0' };

const INPUTS = Object.freeze({
  'fin.sector_margin': (_row, asOfDate, extra) => ({ asOfDate, competenceMonth: asOfDate.slice(0, 7), sectors: (extra && extra.sectors) || [] }),
  'fin.commissions_provisioned': (row, asOfDate) => {
    const d = detail(row, 'provisioned_commissions_detail');
    return { asOfDate, total: d.total || '0', count: d.count || 0, byBroker: d.byBroker || {}, byComponent: d.byComponent || {}, withoutBroker: orphan(d) };
  },
  'fin.commissions_paid': (row, asOfDate) => {
    const d = detail(row, 'paid_commissions_detail');
    return { asOfDate, total: d.total || '0', count: d.count || 0, byBroker: d.byBroker || {}, withoutBroker: orphan(d), withoutEntry: d.withoutEntry || { count: 0, amount: '0' } };
  },
  'fin.owner_repasses_pending': (row, asOfDate) => {
    const d = detail(row, 'owner_repasses_detail');
    return { asOfDate, total: d.total || '0', count: d.count || 0, byOwner: d.byOwner || {}, byProperty: d.byProperty || {}, byAge: d.byAge || [] };
  },
});

const PARAMS = Object.freeze({
  'fin.sector_margin': (s) => ({ maxNoSectorPct: s.maxNoSectorPct }),
  'fin.owner_repasses_pending': (s) => ({ alertBusinessDays: s.alertBusinessDays, bands: s.bands }),
});

/** Dados além da linha do rm_finance_health: a margem lê os setores do mês de competência (centro vazio vira "sem_setor"). */
const EXTRAS = Object.freeze({
  async 'fin.sector_margin'(scope, asOfDate, transaction) {
    const month = asOfDate.slice(0, 7);
    if (!MONTH_RE.test(month)) return { sectors: [] };
    const [rows] = await sequelize.query(
      `SELECT result_center_id::text AS id, revenue_actual::text AS revenue, cost_actual::text AS cost FROM analytics.${SECTOR_MODEL}
        WHERE company_id = :companyId AND competence_month = :month ORDER BY result_center_id`, { replacements: { companyId: scope.companyId, month }, transaction });
    return { sectors: rows.map((r) => ({ id: r.id === NO_CENTER ? 'sem_setor' : r.id, revenue: r.revenue, cost: r.cost })) };
  },
});

module.exports = { DEFINITIONS, INPUTS, PARAMS, EXTRAS };
