'use strict';

/**
 * M9-D654 (3.1 e 3.2) — conteúdo do painel Obras (`construction`): faixa de qualidade, avanço contra o cronograma (barra por obra), atrasos, linha de base x
 * realizado x projetada (três séries, sem total), margem projetada, medições, não conformidades e desperdício. A margem e o custo projetado são
 * "Projetado" (M9-D610); o realizado nunca soma à projetada. O Front só desenha o que a API devolve.
 */
const { QUALITY_BANNER, card, bars, table } = require('./common');

const CONSTRUCTION_PANEL = Object.freeze({
  code: 'construction',
  widgets: [
    QUALITY_BANNER,
    bars('obra.progress_vs_schedule', 'Avanço x cronograma', {
      group: 'obra', valueKey: 'realizado_pct', order: 'VALUE_DESC', labelKind: 'PROJECT',
      extra: [{ key: 'planejado_pct', label: 'Planejado' }, { key: 'desvio_pp', label: 'Desvio' }],
      facts: [{ key: 'planejado_pct', label: 'Planejado (empresa)' }, { key: 'desvio_pp', label: 'Desvio (empresa)' }],
    }),
    card('obra.delays', 'Atrasos', {
      group: 'obra', order: 'VALUE_DESC', labelKind: 'PROJECT', alert: true,
      facts: [{ key: 'maximo_dias', label: 'Maior atraso' }, { key: 'medio_dias', label: 'Atraso médio' }, { key: 'obras_com_atraso_qtd', label: 'Obras com atraso' }],
    }),
    card('obra.baseline_actual_forecast', 'Linha de base, realizado e projetada', {
      noTotal: true,
      series: [
        { key: 'baseline_brl', label: 'Linha de base', nature: 'PLANNED' }, { key: 'actual_brl', label: 'Realizado', nature: 'ACTUAL' }, { key: 'forecast_brl', label: 'Projetada', nature: 'PROJECTED' },
      ],
    }, 'PROJECTED'),
    card('obra.projected_margin', 'Margem projetada', {
      group: 'obra', order: 'VALUE_DESC', labelKind: 'PROJECT',
      facts: [{ key: 'margem_pct', label: 'Margem' }, { key: 'receita_brl', label: 'Receita' }, { key: 'custo_projetado_brl', label: 'Custo projetado' }],
    }, 'PROJECTED'),
    card('obra.measurements', 'Medições', {
      group: 'obra', order: 'VALUE_DESC', labelKind: 'PROJECT',
      facts: [{ key: 'aprovado_brl', label: 'Aprovadas' }, { key: 'pendente_brl', label: 'Pendentes' }, { key: 'pendente_mais_antiga_dias', label: 'Pendente há mais tempo' }],
    }),
    card('obra.nonconformities', 'Não conformidades abertas', {
      groups: [{ group: 'causa', label: 'Causa' }, { group: 'equipe', label: 'Equipe' }], order: 'VALUE_DESC',
      facts: [{ key: 'abertas_periodo_qtd', label: 'Abertas no período' }, { key: 'fechadas_periodo_qtd', label: 'Fechadas no período' }, { key: 'tempo_medio_dias', label: 'Tempo médio para fechar' }],
    }),
    table('obra.waste', 'Desperdício', {
      groups: [{ group: 'obra', label: 'Obra' }, { group: 'material', label: 'Material' }, { group: 'equipe', label: 'Equipe' }], order: 'VALUE_DESC',
      measures: [{ key: '', label: 'Perdas' }, { key: 'consumo_brl', label: 'Consumo' }, { key: 'desperdicio_pct', label: 'Desperdício' }],
      facts: [{ key: 'consumo_brl', label: 'Consumo total' }, { key: 'desperdicio_pct', label: 'Desperdício sobre o consumo' }],
    }),
  ],
});

module.exports = { CONSTRUCTION_PANEL };
