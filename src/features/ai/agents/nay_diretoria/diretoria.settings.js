'use strict';

/**
 * Parâmetros da NAY Diretoria (M9-D035), na aba IA NAY de Configurações. O livro não dá os limites de severidade, as faixas de vencimento
 * nem o tamanho das listas: ficam aqui, com padrão conservador (Maturacao/demandas/parametros.csv).
 */
const DIRETORIA_KEYS = Object.freeze({
  contractBands: 'ia.diretoria.faixas_contrato_vencer_dias',
  portfolioMax: 'ia.diretoria.max_itens_carteira',
  riskMediumMinItems: 'ia.diretoria.risco_medio_min_itens',
  riskHighMinItems: 'ia.diretoria.risco_alto_min_itens',
  delinquencyMediumPct: 'ia.diretoria.inadimplencia_media_pct',
  delinquencyHighPct: 'ia.diretoria.inadimplencia_alta_pct',
  maxRisks: 'ia.diretoria.max_riscos',
  scopeTerms: 'ia.diretoria.termos_escopo',
  forbidAction: 'ia.diretoria.proibicao.executar_acao',
  forbidDetail: 'ia.diretoria.proibicao.detalhe_nominal',
  forbidUnsourced: 'ia.diretoria.proibicao.numero_sem_fonte',
});

// Listas de termos (separadas por vírgula, sem acento, sem diferenciar maiúsculas) que a fronteira do agente usa antes de qualquer modelo.
const SCOPE_TERMS = 'empresa,saude,risco,riscos,prioridade,prioridades,semana,indicador,indicadores,inadimpl,contrato,contratos,obra,obras,estoque,financeir,comercial,funil,pipeline,caso,casos,correspondente,juridic,diretoria,resumo,situacao,como esta,explique,explicar,vencer,vencendo,atrasad,fluxo,caixa,saldo,margem,cliente,clientes,lancamento,lancamentos,faturamento,resultado,carteira,gargalo';
const FORBID_ACTION = 'executar,execute,pague,pagar,faca o pagamento,aprove,aprovar,cancele,cancelar,crie uma tarefa,crie tarefa,criar tarefa,crie uma proposta,gere uma proposta,abra um chamado,envie,enviar mensagem,dispare,demita,contrate,assine,assinar,feche o periodo,altere,alterar,mude,mudar,exclua,apague,proponha uma acao';
const FORBID_DETAIL = 'liste os clientes,lista de clientes,nome dos clientes,quais clientes,qual cliente,quais contratos,numero do contrato,numeros dos contratos,cliente por cliente,detalhe por cliente,detalhar por cliente,detalhe os,detalhar os,em detalhe,valores individuais,cada lancamento,lista nominal,cpf,cnpj,quem sao os inadimplentes,quais sao os inadimplentes,detalhes do caso,detalhe do caso';
const FORBID_UNSOURCED = 'estime,estimativa de cabeca,chute,palpite,invente,quanto voce acha,de cabeca,qual seria o numero,adivinhe';

const DIRETORIA_SETTING_DEFAULTS = Object.freeze({
  [DIRETORIA_KEYS.contractBands]: '30,60,90',
  [DIRETORIA_KEYS.portfolioMax]: 100,
  [DIRETORIA_KEYS.riskMediumMinItems]: 1,
  [DIRETORIA_KEYS.riskHighMinItems]: 5,
  [DIRETORIA_KEYS.delinquencyMediumPct]: 5,
  [DIRETORIA_KEYS.delinquencyHighPct]: 10,
  [DIRETORIA_KEYS.maxRisks]: 10,
  [DIRETORIA_KEYS.scopeTerms]: SCOPE_TERMS,
  [DIRETORIA_KEYS.forbidAction]: FORBID_ACTION,
  [DIRETORIA_KEYS.forbidDetail]: FORBID_DETAIL,
  [DIRETORIA_KEYS.forbidUnsourced]: FORBID_UNSOURCED,
});

const DIRETORIA_SETTINGS_SCHEMA = {
  [DIRETORIA_KEYS.contractBands]: { type: 'string' },
  [DIRETORIA_KEYS.portfolioMax]: { type: 'integer', min: 1, max: 500 },
  [DIRETORIA_KEYS.riskMediumMinItems]: { type: 'integer', min: 1, max: 1000 },
  [DIRETORIA_KEYS.riskHighMinItems]: { type: 'integer', min: 1, max: 1000 },
  [DIRETORIA_KEYS.delinquencyMediumPct]: { type: 'integer', min: 0, max: 100 },
  [DIRETORIA_KEYS.delinquencyHighPct]: { type: 'integer', min: 0, max: 100 },
  [DIRETORIA_KEYS.maxRisks]: { type: 'integer', min: 1, max: 50 },
  [DIRETORIA_KEYS.scopeTerms]: { type: 'string' },
  [DIRETORIA_KEYS.forbidAction]: { type: 'string' },
  [DIRETORIA_KEYS.forbidDetail]: { type: 'string' },
  [DIRETORIA_KEYS.forbidUnsourced]: { type: 'string' },
};

module.exports = { DIRETORIA_KEYS, DIRETORIA_SETTING_DEFAULTS, DIRETORIA_SETTINGS_SCHEMA };
