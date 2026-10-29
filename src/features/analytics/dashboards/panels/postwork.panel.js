'use strict';

/**
 * M9-D654 (3.1 e 3.2) — conteúdo do painel Pós-obra (`postwork`): faixa de qualidade, custo pós-obra (realizado e previsto em séries separadas, sem
 * total) e ranking de recorrência por causa, equipe e material.
 */
const { QUALITY_BANNER, card, table } = require('./common');

const POSTWORK_PANEL = Object.freeze({
  code: 'postwork',
  widgets: [
    QUALITY_BANNER,
    card('obra.postwork_cost', 'Custo pós-obra', {
      noTotal: true, series: [{ key: '', label: 'Realizado', nature: 'ACTUAL' }, { key: 'previsto_brl', label: 'Previsto', nature: 'PLANNED' }],
      groups: [{ group: 'obra', label: 'Obra' }, { group: 'causa', label: 'Causa' }, { group: 'equipe', label: 'Equipe' }, { group: 'material', label: 'Material' }], order: 'VALUE_DESC',
      facts: [{ key: 'custo_pct', label: 'Custo sobre a receita' }, { key: 'receita_brl', label: 'Receita' }],
    }),
    table('obra.recurrence', 'Recorrência de problemas', {
      groups: [{ group: 'causa', label: 'Causa' }, { group: 'equipe', label: 'Equipe' }, { group: 'material', label: 'Material' }], order: 'VALUE_DESC',
      measures: [{ key: '', label: 'Ocorrências' }, { key: 'obras_qtd', label: 'Obras' }, { key: 'custo_brl', label: 'Custo' }],
    }),
  ],
});

module.exports = { POSTWORK_PANEL };
