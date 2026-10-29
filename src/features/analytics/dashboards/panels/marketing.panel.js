'use strict';

/**
 * M9-D673 (3.1 e 3.2) — conteúdo do painel Marketing (`marketing`): faixa de qualidade e os oito indicadores de Marketing na ordem do livro (campanhas, custo, leads e
 * atribuição; entregabilidade e opt-out; frequência e automações bloqueadas ou com falha). Dado puro: o mesmo texto alimenta a migration que publica a versão 2 do painel e os
 * testes. `config` só descreve como desenhar; nenhuma fórmula (o valor de cada cartão é o do endpoint de métrica).
 */
const { QUALITY_BANNER, card, table } = require('./common');

const MARKETING_PANEL = Object.freeze({
  code: 'marketing',
  widgets: [
    QUALITY_BANNER,
    table('mkt.campaigns', 'Campanhas ativas e encerradas', {
      group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'ativas_qtd', label: 'Ativas' }, { key: 'encerradas_qtd', label: 'Encerradas no mês' }], facts: [{ key: 'encerradas_qtd', label: 'Encerradas no mês' }],
    }),
    table('mkt.cost', 'Custo de marketing', { group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'custo_brl', label: 'Custo' }], facts: [{ key: 'planejado_brl', label: 'Ainda a pagar (previsto)' }] }),
    table('mkt.leads', 'Leads de marketing', {
      group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'leads_qtd', label: 'Leads' }], facts: [{ key: 'sem_campanha_qtd', label: 'Sem campanha' }, { key: 'sem_campanha_pct', label: 'Parte sem campanha' }],
    }),
    card('mkt.attribution', 'Atribuição e custo por lead', {
      facts: [{ key: 'leads_atribuidos_qtd', label: 'Leads atribuídos' }, { key: 'vendas_atribuidas_qtd', label: 'Vendas atribuídas' }, { key: 'custo_por_venda_brl', label: 'Custo por venda' }, { key: 'fora_da_janela_qtd', label: 'Atribuições fora da janela' }],
    }),
    table('mkt.deliverability', 'Entregabilidade', {
      group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'entregabilidade_pct', label: 'Entregabilidade' }, { key: 'enviadas_qtd', label: 'Enviadas' }],
      facts: [{ key: 'enviadas_qtd', label: 'Enviadas' }, { key: 'entregues_qtd', label: 'Entregues' }, { key: 'falhas_qtd', label: 'Falhas' }, { key: 'devolvidas_qtd', label: 'Devolvidas' }],
    }),
    table('mkt.opt_out', 'Opt-out', {
      group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'taxa_pct', label: 'Taxa de saída' }, { key: 'saidas_qtd', label: 'Saídas' }], facts: [{ key: 'saidas_qtd', label: 'Pedidos de saída' }, { key: 'alcancados_qtd', label: 'Contatos alcançados' }],
    }),
    table('mkt.frequency', 'Frequência de contato', {
      alertOn: 'acima_do_teto_qtd', group: 'canal', order: 'VALUE_DESC', measures: [{ key: 'media', label: 'Mensagens por pessoa' }],
      facts: [{ key: 'acima_do_teto_qtd', label: 'Pessoas acima do teto' }, { key: 'pessoas_alcancadas_qtd', label: 'Pessoas alcançadas' }, { key: 'mensagens_qtd', label: 'Mensagens' }],
    }),
    table('mkt.automations_blocked_failed', 'Automações bloqueadas e com falha', {
      group: 'motivo', order: 'VALUE_DESC', measures: [{ key: 'bloqueadas_qtd', label: 'Bloqueadas' }],
      facts: [{ key: 'bloqueadas_qtd', label: 'Bloqueadas' }, { key: 'bloqueadas_pct', label: 'Parte bloqueada' }, { key: 'falhas_qtd', label: 'Com falha' }, { key: 'falhas_pct', label: 'Parte com falha' }],
    }),
  ],
});

module.exports = { MARKETING_PANEL };
