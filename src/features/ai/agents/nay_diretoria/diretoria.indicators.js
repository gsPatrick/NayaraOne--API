'use strict';

// M9-D035 — "explicações": catálogo dos indicadores que a Diretoria sabe explicar. Cada um diz de qual read model vem, em que período vale e
// qual é a fórmula, e aponta os itens do payload que mostram o valor atual. O texto não tem número: os valores são {{num:ref}}.
const INDICATORS = Object.freeze([
  {
    code: 'inadimplencia', terms: ['inadimpl'], topic: 'finance', label: 'Inadimplência', refs: ['inadimplencia_percentual', 'inadimplencia_valor'],
    readModel: 'finance.getWeeklyHealthReport', period: 'posição na data da consulta, sobre os recebíveis próprios pendentes com vencimento já passado',
    formula: 'recebíveis próprios vencidos divididos pelo total elegível a receber, em percentual',
    value: 'índice de {{num:inadimplencia_percentual}}, com {{num:inadimplencia_valor}} vencidos',
  },
  {
    code: 'saldo', terms: ['saldo', 'fluxo', 'caixa'], topic: 'finance', label: 'Saldo líquido projetado', refs: ['saldo_projetado'],
    readModel: 'finance.getWeeklyHealthReport', period: 'posição na data da consulta, sobre os lançamentos pendentes', formula: 'a receber próprio pendente menos a pagar pendente; é projeção, não saldo bancário',
    value: '{{num:saldo_projetado}}',
  },
  {
    code: 'contratos', terms: ['contrato', 'vencer', 'vencimento'], topic: 'legal', label: 'Contratos a vencer', refs: null,
    readModel: 'legal.contracts', period: 'contratos ativos cuja vigência termina dentro das faixas de dias configuradas', formula: 'contagem e soma do valor dos contratos ativos por faixa de dias até o fim da vigência',
    value: null,
  },
  {
    code: 'obras', terms: ['obra', 'obras', 'atraso'], topic: 'construction', label: 'Obras atrasadas', refs: ['obras_atrasadas', 'obras_ativas'],
    readModel: 'construction.projects', period: 'posição na data da consulta, sobre as obras em execução', formula: 'obras em execução cujo prazo planejado já venceu, contadas pelo módulo de Obras',
    value: '{{num:obras_atrasadas}} obras atrasadas entre {{num:obras_ativas}} em execução',
  },
  {
    code: 'casos', terms: ['caso', 'casos', 'correspondente', 'financiamento'], topic: 'correspondent', label: 'Casos de financiamento parados', refs: ['casos_parados_total', 'casos_parados_limiar'],
    readModel: 'correspondent.financing_cases', period: 'posição na data da consulta, sobre os casos que ainda não terminaram', formula: 'casos sem nenhuma atividade há mais dias que o limiar configurado no Correspondente',
    value: '{{num:casos_parados_total}} casos parados há mais de {{num:casos_parados_limiar}}',
  },
  {
    code: 'estoque', terms: ['estoque'], topic: 'inventory', label: 'Estoque em risco', refs: ['estoque_em_risco', 'estoque_ruptura'],
    readModel: 'inventory.balances', period: 'posição na data da consulta, sobre o consumo da janela configurada no Estoque', formula: 'itens cujo saldo projetado fica abaixo do ponto de reposição (mínimo mais consumo durante o prazo de reposição)',
    value: '{{num:estoque_em_risco}} itens em risco, {{num:estoque_ruptura}} com risco de ruptura',
  },
  {
    code: 'funil', terms: ['funil', 'pipeline', 'oportunidade', 'comercial'], topic: 'crm', label: 'Funil comercial', refs: ['funil_abertas', 'funil_valor'],
    readModel: 'crm.opportunities', period: 'posição na data da consulta, sobre as oportunidades em etapas não encerradas', formula: 'oportunidades em aberto, contadas e somadas pelo valor esperado de cada uma',
    value: '{{num:funil_abertas}} oportunidades em aberto, {{num:funil_valor}} de valor esperado',
  },
]);

/** O indicador citado no pedido (texto já sem acento e em minúsculas); o primeiro da lista que casa. */
const pickIndicator = (normalizedText) => INDICATORS.find((i) => i.terms.some((t) => normalizedText.includes(t))) || null;

module.exports = { INDICATORS, pickIndicator };
