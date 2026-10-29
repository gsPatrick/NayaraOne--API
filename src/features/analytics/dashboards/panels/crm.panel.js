'use strict';

/**
 * M9-D634 (3.1 e 3.2) — conteúdo do painel Vendas/CRM (`crm`): 15 blocos na ordem do livro (a faixa de qualidade e os 14 indicadores de CRM, imóveis e
 * Radar). Dado puro: o mesmo texto alimenta a migration que publica a versão 2 do painel e os testes. `config` só descreve como desenhar
 * (`group` = prefixo das dimensões que formam barras ou linhas, `share` = medida da participação, `extra` e `measures` = colunas, `facts` = fatos do
 * cartão, `order` = modo de ordenação, `alertOn` = chave que acende o alerta, `link` = tela que o cartão abre); nenhuma fórmula.
 */
const { QUALITY_BANNER, card, bars, table } = require('./common');

const CRM_PANEL = Object.freeze({
  code: 'crm',
  widgets: [
    QUALITY_BANNER,
    bars('crm.leads_by_origin', 'Leads por origem', { group: 'origem', share: 'parte_pct' }),
    card('crm.first_response_time', 'Tempo até a primeira resposta', { facts: [{ key: 'sem_resposta_qtd', label: 'Leads sem resposta' }] }),
    bars('crm.opportunities_by_stage', 'Oportunidades por estágio', {
      chart: 'FUNNEL', group: 'estagio', order: 'STAGES_CRM', extra: [{ key: 'media_dias', label: 'Tempo médio parado' }], highlight: { key: 'paradas_qtd', label: 'Oportunidades paradas' },
    }),
    card('crm.conversion_rate', 'Conversão', { facts: [{ key: 'ganhas_qtd', label: 'Ganhas' }, { key: 'perdidas_qtd', label: 'Perdidas' }] }),
    table('crm.broker_conversion', 'Conversão por corretor', { group: 'corretor', order: 'VALUE_DESC', measures: [{ key: 'taxa_pct', label: 'Conversão' }, { key: 'fechadas_qtd', label: 'Fechadas' }], labelKind: 'USER' }),
    bars('crm.loss_reasons', 'Motivos de perda', { group: 'motivo', share: 'parte_pct' }),
    card('crm.portfolio_without_next_action', 'Carteira sem próxima ação', {
      alert: true, link: { href: '/painel/crm', label: 'Ver oportunidades' }, facts: [{ key: 'em_aberto_qtd', label: 'Oportunidades em aberto' }, { key: 'sem_acao_pct', label: 'Sem próxima ação' }],
    }),
    card('crm.visits', 'Visitas', { facts: [{ key: 'realizadas', label: 'Realizadas' }, { key: 'comparecimento_pct', label: 'Comparecimento' }] }),
    card('crm.proposals', 'Propostas', {
      facts: [{ key: 'aceitas', label: 'Aceitas' }, { key: 'recusadas', label: 'Recusadas' }, { key: 'expiradas', label: 'Expiradas' }, { key: 'em_aberto', label: 'Em aberto' },
        { key: 'valor_total_brl', label: 'Valor proposto' }, { key: 'taxa_aceite_pct', label: 'Taxa de aceite' }],
    }),
    card('prop.active_properties', 'Imóveis ativos', { group: 'finalidade', order: 'VALUE_DESC' }),
    bars('prop.without_sale_by_period', 'Imóveis sem venda por período', { group: 'faixa', order: 'NUMERIC', facts: [{ key: 'sem_data', label: 'Sem data de entrada' }] }),
    card('prop.price_changes', 'Mudanças de preço', { facts: [{ key: 'variacao_media_pct', label: 'Variação média' }] }),
    card('radar.matches', 'Radar de oportunidades', { facts: [{ key: 'enviados', label: 'Avisados' }, { key: 'convertidos', label: 'Convertidos' }, { key: 'taxa_pct', label: 'Taxa' }] }),
    table('crm.broker_capture', 'Captação por corretor', {
      group: 'corretor', order: 'VALUE_DESC', measures: [{ key: 'captados', label: 'Imóveis captados' }, { key: 'valor_medio_brl', label: 'Valor médio' }], labelKind: 'USER', facts: [{ key: 'sem_captador', label: 'Sem captador' }],
    }),
  ],
});

module.exports = { CRM_PANEL };
