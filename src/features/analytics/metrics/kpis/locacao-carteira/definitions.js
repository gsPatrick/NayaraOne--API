'use strict';

/**
 * M9-D640 — definição, no Metric Registry, dos três KPIs da carteira de Locação: contratos ativos, vacância e inadimplência da locação. Os 15 campos do livro (M9-D603): fonte (o
 * read model de Locação de cada KPI), fórmula versionada no código (formulas/rent*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>),
 * política de atualização e regra de qualidade, como escritos na demanda. Versão 1. rent.delinquency é CRITICAL (tabela da M9-D712): nasce com drill-down.
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Locação (M9-D708): contratos ativos, vacância e inadimplência conforme o módulo de Contratos e Locação e o Financeiro';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job às 00:05 e evento
const QUARTER_HOUR = Object.freeze({ mode: 'SCHEDULE', cron: '*/15 * * * *', maxStalenessMinutes: 15 });
const quality = (maxStalenessMinutes, requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'rent.active_contracts', name: 'Contratos de locação ativos', sourceReadModel: 'rm_rental_contracts', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos contratos de locação estão valendo e quanto eles somam de aluguel mensal; os suspensos aparecem à parte.',
    formulaSemantic: 'Contagem de contratos de locação com status ACTIVE na data-base (o valor) e soma do aluguel mensal vigente em reais; SUSPENDED à parte. Contrato ACTIVE sem valor de aluguel deixa o KPI DEGRADED. Faixas de valor em analytics.locacao.faixas_valor_aluguel.',
    dimensions: ['empresa', 'imóvel', 'proprietário', 'faixa de valor'], qualityRule: quality(15, ['without_rent', 'rent_total']),
  },
  {
    metricCode: 'rent.vacancy', name: 'Vacância', sourceReadModel: 'rm_rental_vacancy', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Que parte dos imóveis locáveis está sem contrato de locação ativo hoje.',
    formulaSemantic: 'vacância (%) = imóveis locáveis sem contrato ACTIVE na data-base ÷ imóveis locáveis × 100 (2 casas); locável = imóvel com finalidade de locação ativa no portfólio. Total locável zero é INCOMPLETE; imóvel com oferta ou contrato e situação desconhecida deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'tipo', 'bairro', 'proprietário'], qualityRule: quality(1440, ['rentable_total', 'status_undefined']),
  },
  {
    metricCode: 'rent.delinquency', name: 'Inadimplência da locação', sourceReadModel: 'rm_rental_arrears', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: QUARTER_HOUR,
    description: 'Que parte do aluguel e dos encargos cobrados nos últimos 90 dias (janela do administrador) segue em atraso; o recorte de locação da taxa de inadimplência do Financeiro.',
    formulaSemantic: 'taxa = Σ entradas próprias PENDING de contratos de locação com vencimento em [hoje − janela + 1, hoje − 1] ÷ Σ cobrado na mesma janela mais hoje (exceto REVERSED e CANCELLED) × 100 (2 casas); o vencido antes da janela fica fora e em details.overdueOutsideWindow; o vencido absoluto sai em vencido_brl. Cobrança sem contrato de locação fica só no Financeiro e em details.unlinked.',
    dimensions: ['empresa', 'contrato', 'imóvel', 'faixa de atraso'], qualityRule: quality(15, ['billed_90d', 'overdue_amount_in_window_90d', 'without_due_date']),
  },
]);

module.exports = { DEFINITIONS };
