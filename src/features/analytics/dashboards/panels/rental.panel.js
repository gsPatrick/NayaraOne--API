'use strict';

/**
 * M9-D643 (3.2) — conteúdo do painel Locação (`rental`): faixa de qualidade e os oito blocos do livro na ordem (contratos ativos, vacância e inadimplência; garantias a vencer,
 * com a lista no detalhe; obrigações pendentes; vistorias e chaves; chamados; satisfação; repasses). Dado puro: o mesmo texto alimenta a migration que publica a versão 2 do
 * painel e os testes. `config` só descreve como desenhar; nenhuma fórmula (o valor de cada cartão é o do endpoint de métrica).
 */
const { QUALITY_BANNER, card } = require('./common');

const RENTAL_PANEL = Object.freeze({
  code: 'rental',
  widgets: [
    QUALITY_BANNER,
    card('rent.active_contracts', 'Contratos ativos', {
      group: 'faixa_valor', order: 'BANDS', facts: [{ key: 'aluguel_mensal_brl', label: 'Aluguel mensal vigente' }, { key: 'suspensos_qtd', label: 'Suspensos' }],
    }),
    card('rent.vacancy', 'Vacância', { facts: [{ key: 'locaveis_qtd', label: 'Imóveis locáveis' }, { key: 'alugados_qtd', label: 'Alugados' }, { key: 'vagos_qtd', label: 'Vagos' }, { key: 'suspensos_qtd', label: 'Com contrato suspenso' }] }),
    card('rent.delinquency', 'Inadimplência da locação', {
      group: 'faixa', order: 'NUMERIC', facts: [{ key: 'vencido_brl', label: 'Vencido' }, { key: 'cobrado_brl', label: 'Cobrado no período' }, { key: 'nao_vinculado_brl', label: 'Cobrança sem contrato de locação' }],
    }),
    card('rent.guarantees_expiring', 'Garantias a vencer', {
      group: 'tipo', valueKey: 'vencendo_30d_qtd', order: 'VALUE_DESC', facts: [{ key: 'vencendo_30d_qtd', label: 'Vencem em até 30 dias' }, { key: 'vencendo_60d_qtd', label: 'Vencem em até 60 dias' }, { key: 'vencidas_qtd', label: 'Vencidas' }],
    }),
    card('rent.obligations_pending', 'Obrigações pendentes', {
      group: 'tipo', valueKey: 'abertas_qtd', order: 'VALUE_DESC', facts: [{ key: 'vencidas_qtd', label: 'Vencidas' }, { key: 'a_vencer_qtd', label: 'A vencer' }, { key: 'mais_antiga_dias', label: 'Vencida há mais tempo' }],
    }),
    card('rent.inspections_keys', 'Vistorias e chaves', {
      noTotal: true,
      series: [{ key: '', label: 'Vistorias pendentes', nature: 'ACTUAL' }, { key: 'vistorias_atrasadas_qtd', label: 'Vistorias atrasadas', nature: 'ACTUAL' },
        { key: 'chaves_fora_qtd', label: 'Chaves fora', nature: 'ACTUAL' }, { key: 'chaves_atrasadas_qtd', label: 'Chaves atrasadas', nature: 'ACTUAL' }],
    }),
    card('rent.tickets', 'Chamados abertos', {
      facts: [{ key: 'tempo_medio_resolucao_horas', label: 'Tempo médio de resolução' }, { key: 'abertos_periodo_qtd', label: 'Abertos no mês' }, { key: 'fechados_periodo_qtd', label: 'Fechados no mês' }],
    }),
    card('rent.satisfaction', 'Satisfação da locação', { group: 'papel', facts: [{ key: 'respostas_qtd', label: 'Respostas' }] }),
    card('rent.repasses', 'Repasses', {
      alertOn: 'atrasados_brl', facts: [{ key: 'pagos_brl', label: 'Pagos' }, { key: 'pendentes_no_prazo_brl', label: 'Pendentes no prazo' }, { key: 'atrasados_brl', label: 'Atrasados' }, { key: 'no_prazo_pct', label: 'Pagos no prazo' }],
    }),
  ],
});

module.exports = { RENTAL_PANEL };
