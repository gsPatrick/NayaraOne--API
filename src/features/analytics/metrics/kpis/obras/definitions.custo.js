'use strict';

// M9-D650 — textos dos KPIs de avanço, custo e margem das obras (os 15 campos do livro, M9-D603): descrição, fórmula em palavras e regra de qualidade.
const { buildDefinitions } = require('./definitions.build');

const TEXT = {
  'obra.progress_vs_schedule': {
    description: 'Quanto cada obra deveria ter avançado pelo cronograma (planejado) e quanto avançou (realizado), em % ponderado pelo peso financeiro das etapas; o desvio em pontos percentuais é negativo quando há atraso.',
    formulaSemantic: 'planejado% (baseline) = Σ peso × %planejado da etapa ÷ Σ peso; realizado% (actual) = Σ peso × %medido ÷ Σ peso; desvio (p.p.) = realizado% − planejado%, 2 casas; etapa sem peso usa peso 1; a empresa é a média das obras ponderada pelo orçamento. Posição no fim do dia-base de São Paulo.',
    qualityRule: { requiredFields: ['baseline_percent', 'actual_percent'], allowNull: false, incompleteWhen: 'obra sem cronograma baseline' },
  },
  'obra.baseline_actual_forecast': {
    description: 'Três séries separadas do custo das obras: baseline (orçamento aprovado), actual (saídas liquidadas até o dia-base) e forecast (projeção do custo final). Nunca são somadas entre si.',
    formulaSemantic: 'baseline = orçamento de custo aprovado; actual = Σ saídas SETTLED da obra até a data-base; forecast (PROJECTED) = actual + custoAFazer, custoAFazer = max(0, baseline × (1 − realizado%/100)) × fatorDesvio, fatorDesvio = max(1, actual ÷ (baseline × realizado%/100)) quando realizado% > 0 e 1 quando realizado% = 0; o desvio não é arredondado no meio da conta.',
    qualityRule: { requiredFields: ['forecast_cost', 'actual_percent'], allowNull: false, incompleteWhen: 'forecast sem progresso medido' },
  },
  'obra.projected_margin': {
    description: 'Quanto cada obra deve render no fim: receita contratada menos o custo final projetado, em reais e em % da receita. Sempre rotulada "Projetada".',
    formulaSemantic: 'margemProjetada% = (receitaContratada − forecastCusto) ÷ receitaContratada × 100, 2 casas, e valor = receitaContratada − forecastCusto; receita contratada zero ou forecast INCOMPLETE deixa o indicador INCOMPLETE.',
    qualityRule: { requiredFields: ['contract_revenue', 'forecast_cost'], allowNull: false, incompleteWhen: 'forecast INCOMPLETE' },
  },
};

module.exports = { DEFINITIONS: buildDefinitions(TEXT) };
