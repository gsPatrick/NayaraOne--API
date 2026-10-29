'use strict';

/**
 * M9-D654 (3.1 e 3.2) — conteúdo do painel Estoque/Patrimônio (`inventory`): faixa de qualidade, valor em estoque, itens abaixo do mínimo, perdas e
 * ferramentas em atraso. Cada cartão leva os fatos prontos do indicador e o atalho para a tela de origem; o detalhe do que é crítico (perdas) segue a M9-D690.
 */
const { QUALITY_BANNER, card } = require('./common');

const INVENTORY_PANEL = Object.freeze({
  code: 'inventory',
  widgets: [
    QUALITY_BANNER,
    card('inv.stock_value', 'Valor em estoque', { link: { href: '/painel/estoque', label: 'Ver itens' }, facts: [{ key: 'sem_custo_qtd', label: 'Itens sem custo' }] }),
    card('inv.below_minimum', 'Itens abaixo do mínimo', {
      link: { href: '/painel/estoque', label: 'Ver itens' }, facts: [{ key: 'rupturas_qtd', label: 'Rupturas (sem saldo)' }, { key: 'sem_minimo_qtd', label: 'Itens sem estoque mínimo' }],
    }),
    card('inv.losses', 'Perdas de estoque', {
      link: { href: '/painel/estoque/perdas', label: 'Ver perdas' },
      facts: [{ key: 'casos_qtd', label: 'Casos na janela' }, { key: 'abertos_qtd', label: 'Casos em aberto' }, { key: 'sem_valor_qtd', label: 'Casos sem valor' }],
    }),
    card('inv.tools_overdue', 'Ferramentas em atraso', {
      link: { href: '/painel/estoque/patrimonio', label: 'Ver ferramentas' },
      facts: [{ key: 'abertos_qtd', label: 'Empréstimos em aberto' }, { key: 'manutencao_qtd', label: 'Ativos em manutenção' }, { key: 'sem_data_qtd', label: 'Sem data de devolução' }],
    }),
  ],
});

module.exports = { INVENTORY_PANEL };
