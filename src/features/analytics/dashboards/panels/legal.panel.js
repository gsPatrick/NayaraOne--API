'use strict';

/**
 * M9-D662 (3.1 e 3.2) — conteúdo do painel Jurídico (`legal`): faixa de qualidade, prazos (cartão com alerta), processos por risco, valores em duas séries
 * (estimado e confirmado, nunca somados) e documentos faltantes. O jurídico exibe agregados; o detalhe exige a permissão do domínio (M9-D690).
 */
const { QUALITY_BANNER, card, bars, table } = require('./common');

const LEGAL_PANEL = Object.freeze({
  code: 'legal',
  widgets: [
    QUALITY_BANNER,
    card('legal.deadlines', 'Prazos jurídicos', {
      alertOn: 'vencidos_qtd',
      facts: [{ key: 'proximos_7d_qtd', label: 'Vencem em até 7 dias' }, { key: 'ate_30d_qtd', label: 'Vencem em até 30 dias' }, { key: 'vencidos_qtd', label: 'Vencidos' },
        { key: 'mais_antigo_vencido_dias', label: 'Vencido há mais tempo' }],
    }),
    bars('legal.cases_by_risk', 'Processos por risco', { group: 'risco', order: 'VALUE_DESC' }),
    card('legal.values', 'Valores dos processos', {
      noTotal: true, series: [{ key: '', label: 'Estimado', nature: 'ESTIMATED' }, { key: 'confirmado_brl', label: 'Confirmado', nature: 'ACTUAL' }], facts: [{ key: 'sem_valor_qtd', label: 'Processos sem valor' }],
    }, 'ESTIMATED'),
    table('legal.missing_documents', 'Documentos faltantes', {
      group: 'tipo', order: 'VALUE_DESC', measures: [{ key: '', label: 'Exigências pendentes' }, { key: 'contratos_qtd', label: 'Contratos' }], facts: [{ key: 'contratos_qtd', label: 'Contratos com pendência' }],
    }),
  ],
});

module.exports = { LEGAL_PANEL };
