'use strict';

/**
 * M9-D662 (3.1 e 3.2) — conteúdo do painel Correspondente (`correspondent`): faixa de qualidade, funil de casos por estágio, aprovação por provider, tempo de
 * análise e comissão em três séries separadas (esperada, confirmada e recebida), sem total.
 */
const { QUALITY_BANNER, card, bars, table } = require('./common');

const CORRESPONDENT_PANEL = Object.freeze({
  code: 'correspondent',
  widgets: [
    QUALITY_BANNER,
    bars('cor.cases_by_stage', 'Casos por estágio', { chart: 'FUNNEL', group: 'estagio', order: 'STAGES_COR', extra: [{ key: 'tempo_medio_dias', label: 'Tempo médio no estágio' }] }),
    table('cor.approval_rate_by_provider', 'Aprovação por provider', {
      group: 'provider', order: 'VALUE_DESC', measures: [{ key: 'taxa_pct', label: 'Aprovação' }, { key: 'aprovadas_qtd', label: 'Aprovadas' }, { key: 'rejeitadas_qtd', label: 'Rejeitadas' }],
      facts: [{ key: 'aprovadas_qtd', label: 'Aprovadas' }, { key: 'rejeitadas_qtd', label: 'Rejeitadas' }, { key: 'taxa_pct', label: 'Taxa de aprovação' }],
    }),
    table('cor.analysis_time', 'Tempo de análise', {
      group: 'provider', order: 'VALUE_DESC', measures: [{ key: 'media_dias', label: 'Média de análise' }], facts: [{ key: 'decididos_qtd', label: 'Decididos' }, { key: 'pendentes_qtd', label: 'Pendentes' }],
    }),
    card('cor.commission', 'Comissão do correspondente', {
      noTotal: true,
      series: [{ key: '', label: 'Esperada', nature: 'ESTIMATED' }, { key: 'confirmada_brl', label: 'Confirmada', nature: 'PLANNED' }, { key: 'recebida_brl', label: 'Recebida', nature: 'ACTUAL' }],
      facts: [{ key: 'a_receber_brl', label: 'A receber (confirmada menos recebida)' }],
    }, 'ESTIMATED'),
  ],
});

module.exports = { CORRESPONDENT_PANEL };
