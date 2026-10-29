'use strict';

/**
 * M9-D673 (3.1 e 3.2) — conteúdo do painel Atendimento/Satisfação (`support`): faixa de qualidade, reviews, satisfação, reclamações por motivo e SLA de resolução, na ordem
 * do livro. Dado puro (migration e testes usam o mesmo texto). O cartão de SLA acende o alerta quando há caso em aberto já vencido.
 */
const { QUALITY_BANNER, card, table } = require('./common');

const SUPPORT_PANEL = Object.freeze({
  code: 'support',
  widgets: [
    QUALITY_BANNER,
    table('sup.reviews', 'Reviews', {
      group: 'plataforma', order: 'VALUE_DESC', measures: [{ key: 'nota_media', label: 'Nota média' }, { key: 'reviews_qtd', label: 'Reviews' }],
      facts: [{ key: 'reviews_qtd', label: 'Reviews no mês' }, { key: 'nota_5_qtd', label: 'Nota 5' }, { key: 'nota_4_qtd', label: 'Nota 4' }, { key: 'nota_3_qtd', label: 'Nota 3' }, { key: 'nota_2_qtd', label: 'Nota 2' }, { key: 'nota_1_qtd', label: 'Nota 1' }],
    }),
    card('sup.satisfaction', 'Satisfação (CSAT)', { facts: [{ key: 'respostas_qtd', label: 'Respostas' }, { key: 'notas_4_5_qtd', label: 'Notas 4 ou 5' }, { key: 'notas_4_5_pct', label: 'Parte com nota 4 ou 5' }] }),
    table('sup.complaints_by_reason', 'Reclamações por motivo', { group: 'motivo', order: 'VALUE_DESC', link: { href: '/painel/crm/feedback', label: 'Ver reclamações' }, measures: [{ key: 'qtd', label: 'Reclamações' }, { key: 'pct', label: 'Participação' }] }),
    table('sup.sla_resolution', 'SLA de resolução', {
      alertOn: 'abertos_vencidos_qtd', group: 'prioridade', order: 'VALUE_DESC', link: { href: '/painel/crm/feedback', label: 'Ver casos' },
      measures: [{ key: 'dentro_pct', label: 'Dentro do SLA' }, { key: 'resolvidos_qtd', label: 'Resolvidos' }],
      facts: [{ key: 'resolvidos_qtd', label: 'Resolvidos' }, { key: 'dentro_do_sla_qtd', label: 'Dentro do SLA' }, { key: 'abertos_vencidos_qtd', label: 'Abertos já vencidos' }],
    }),
  ],
});

module.exports = { SUPPORT_PANEL };
