'use strict';

/**
 * M9-D710 — definição, no Metric Registry, dos três KPIs de fatos do dia do Centro de Comando. Os 15 campos do livro (M9-D603): fonte (rm_command_events), fórmula versionada no código
 * (formulas/*.js, id = código), dimensões, unidade (a contagem é o valor; o valor em BRL vai nas dimensões), owner (parâmetro analytics.owner.<código>), política de atualização
 * (por evento, no máximo 15 min de defasagem) e regra de qualidade, como escritos na demanda. Versão 1. Os três são CRITICAL na tabela da M9-D712: nascem com drill-down.
 */
const REFERENCE_REPORT = 'Conferência dos fatos do dia do Centro de Comando contra Contratos, CRM e Financeiro (M9-D708)';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });
const WINDOW = 'dentro da janela móvel de analytics.centro.janela_horas (padrão 24 h), no calendário de São Paulo; a comparação usa a janela anterior de mesma duração';

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'legal.contracts_signed', name: 'Contratos assinados na janela', sourceReadModel: 'rm_command_events', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Quantos contratos foram assinados na janela do Centro de Comando e quanto valem em reais.',
    formulaSemantic: `Contagem de contratos cujo estado passou a assinado ${WINDOW}; o valor em reais é a soma do valor do contrato (contrato sem valor não soma). Contrato revertido soma zero (linha original e compensatória). Contrato assinado sem data de assinatura deixa o KPI INCOMPLETE.`,
    dimensions: ['empresa', 'tipo de contrato'], qualityRule: quality(['count', 'amount', 'previous']),
  },
  {
    metricCode: 'crm.opportunities_won', name: 'Oportunidades ganhas na janela', sourceReadModel: 'rm_command_events', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Quantas oportunidades foram ganhas na janela do Centro de Comando e quanto valem em reais.',
    formulaSemantic: `Contagem de oportunidades que entraram no estágio ganho ${WINDOW}; o valor em reais é a soma da proposta aceita. Oportunidade ganha sem proposta aceita conta, tem valor nulo na linha e entra em details.withoutValue. Ganho desfeito soma zero. Ganho sem data deixa o KPI INCOMPLETE.`,
    dimensions: ['empresa', 'corretor', 'origem'], qualityRule: quality(['count', 'amount', 'withoutValue', 'previous']),
  },
  {
    metricCode: 'fin.payments_settled_relevant', name: 'Pagamentos liquidados acima do valor relevante', sourceReadModel: 'rm_command_events', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: EVENT,
    description: 'Quantas saídas liquidadas na janela do Centro de Comando têm valor igual ou acima do valor relevante e quanto somam em reais.',
    formulaSemantic: `Contagem e soma (BRL) das saídas liquidadas ${WINDOW}, com valor igual ou acima de analytics.centro.valor_relevante (padrão R$ 10.000,00, inclusivo); estornadas somam zero e canceladas ficam de fora; dinheiro de terceiros aparece à parte (terceiros_qtd e terceiros_valor_brl), nunca somado ao próprio. Liquidação sem data deixa o KPI INCOMPLETE.`,
    dimensions: ['empresa', 'conta', 'terceiro sim/não'], qualityRule: quality(['count', 'amount', 'thirdParty', 'previous']),
  },
]);

module.exports = { DEFINITIONS };
