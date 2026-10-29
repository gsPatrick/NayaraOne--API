'use strict';

/**
 * M9-D626 (3.1) — conteúdo do painel Financeiro (`finance`): 13 widgets na ordem do livro. A faixa de qualidade vem primeiro (M9-D697); depois caixa livre e dinheiro de
 * terceiros lado a lado, a necessidade para respirar (com o texto do horizonte), a matriz de contas a pagar e a receber em 7, 30 e 60 dias (2 linhas x 3 colunas, PREVISTO),
 * vencidos e inadimplência, margem por setor, comissões e repasses, e conciliações e anomalias (cartões com alerta quando passam do limiar do alerta publicado). Dado puro: o
 * mesmo texto alimenta a migration que publica a versão 2 do painel e os testes. `config` só descreve como desenhar; nenhuma fórmula. `consolidate` marca os cartões que o seletor
 * Grupo (M9-D625) soma entre empresas; os demais indicadores não se somam e ficam só na visão da empresa.
 */
const { QUALITY_BANNER, card, bars, table } = require('./common');
const { CONCILIACOES_KEY, ANOMALIAS_KEY } = require('../../panelSettings');

const WINDOWS = ['7d', '30d', '60d'];
const MATRIX = Object.freeze({
  columns: ['7 dias', '30 dias', '60 dias'],
  rows: [
    { label: 'A pagar', metrics: WINDOWS.map((w) => `fin.payables_${w}`) },
    { label: 'A receber', metrics: WINDOWS.map((w) => `fin.receivables_${w}`) },
  ],
});

const FINANCE_PANEL = Object.freeze({
  code: 'finance',
  widgets: [
    QUALITY_BANNER,
    card('fin.free_cash', 'Caixa livre', { consolidate: true }),
    card('fin.third_party_cash', 'Dinheiro de terceiros (não é caixa livre)', { group: 'origem', order: 'VALUE_DESC', consolidate: true }),
    card('fin.breathing_need', 'Necessidade para respirar', {
      zeroText: 'Sem necessidade no horizonte', horizonText: 'Horizonte de 30 dias: contas a pagar vencidas e em 30 dias e comissões a pagar, menos o caixa livre.',
      facts: [{ key: 'vencido_a_pagar_brl', label: 'Contas vencidas' }, { key: 'a_pagar_30d_brl', label: 'A pagar em 30 dias' }, { key: 'comissoes_brl', label: 'Comissões a pagar' }, { key: 'caixa_livre_brl', label: 'Caixa livre' }],
    }, 'PROJECTED'),
    table('fin.payables_7d', 'Contas a pagar e a receber', { matrix: MATRIX, consolidate: true }, 'PLANNED'),
    card('fin.overdue_receivables', 'Recebíveis vencidos', {
      facts: [{ key: 'quantidade_qtd', label: 'Lançamentos vencidos' }, { key: 'dentro_janela_brl', label: 'Na janela da taxa' }, { key: 'fora_janela_brl', label: 'Fora da janela' }],
    }),
    card('fin.delinquency_rate', 'Taxa de inadimplência', { facts: [{ key: 'vencido_janela_brl', label: 'Vencido na janela' }, { key: 'base_brl', label: 'Base cobrada' }] }),
    bars('fin.sector_margin', 'Margem por setor', {
      group: 'setor', valueKey: 'margem_brl', order: 'VALUE_DESC', labelKind: 'RESULT_CENTER',
      extra: [{ key: 'margem_pct', label: 'Margem' }, { key: 'receita_brl', label: 'Receita' }, { key: 'custo_brl', label: 'Custo' }],
    }),
    card('fin.commissions_provisioned', 'Comissões provisionadas', { facts: [{ key: 'sem_corretor_brl', label: 'Sem corretor' }, { key: 'sem_corretor_qtd', label: 'Parcelas sem corretor' }] }, 'PLANNED'),
    card('fin.commissions_paid', 'Comissões pagas', { facts: [{ key: 'sem_lancamento_brl', label: 'Paga sem lançamento' }, { key: 'sem_lancamento_qtd', label: 'Parcelas sem lançamento' }] }),
    card('fin.owner_repasses_pending', 'Repasses pendentes a proprietários', {
      facts: [{ key: 'quantidade_qtd', label: 'Repasses' }, { key: 'idade_media_dias', label: 'Idade média' }, { key: 'vencidos_alerta_brl', label: 'Vencidos além do alerta' }, { key: 'vencidos_alerta_qtd', label: 'Repasses vencidos' }],
    }),
    card('fin.reconciliations_pending', 'Conciliações pendentes', {
      alertLimit: { settingKey: CONCILIACOES_KEY }, link: { href: '/painel/financeiro/conciliacao', label: 'Ver conciliação' },
      facts: [{ key: 'valor_brl', label: 'Valor pendente' }, { key: 'mais_antiga_dias', label: 'Mais antiga' }],
    }),
    card('fin.anomalies_open', 'Anomalias abertas', {
      alertLimit: { settingKey: ANOMALIAS_KEY }, link: { href: '/painel/financeiro/antifraude', label: 'Ver anomalias' },
      facts: [{ key: 'alto', label: 'Risco alto' }, { key: 'mais_antiga_dias', label: 'Mais antiga' }],
    }),
  ],
});

module.exports = { FINANCE_PANEL, MATRIX };
