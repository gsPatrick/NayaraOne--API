'use strict';

/**
 * Parâmetros da NAY Financeira (M9-D036) na aba IA NAY. `ia.financeira.permitir_proposta_pagamento` é da M9-D019 (approval.settings.js) e a
 * M9-D036 só a reaproveita. Aqui entram o tamanho da lista de anomalias e as listas de termos da fronteira do agente (sem acento, minúsculas,
 * separadas por vírgula): o livro só diz "sem pagar", e as proibições abaixo são as da demanda.
 */
const FINANCEIRA_KEYS = Object.freeze({
  anomaliesMax: 'ia.financeira.anomalias_max_itens',
  suggestionsMax: 'ia.financeira.sugestoes_max_itens',
  renegotiateAfterDays: 'ia.financeira.dias_renegociacao',
  scopeTerms: 'ia.financeira.termos_escopo',
  forbidPay: 'ia.financeira.proibicao.pagar',
  forbidSettle: 'ia.financeira.proibicao.liquidar',
  forbidPayee: 'ia.financeira.proibicao.alterar_favorecido',
  forbidBankAccount: 'ia.financeira.proibicao.alterar_conta_bancaria',
  forbidClosePeriod: 'ia.financeira.proibicao.fechar_periodo',
  forbidCreateEntry: 'ia.financeira.proibicao.criar_lancamento',
});

const FINANCEIRA_SETTING_DEFAULTS = Object.freeze({
  [FINANCEIRA_KEYS.anomaliesMax]: 20,
  [FINANCEIRA_KEYS.suggestionsMax]: 10,
  [FINANCEIRA_KEYS.renegotiateAfterDays]: 30,
  [FINANCEIRA_KEYS.scopeTerms]: 'fluxo,caixa,saldo,inadimpl,vencid,atraso,atrasad,receber,pagar,pagamento,anomalia,anomalias,projecao,projetar,lancamento,lancamentos,financeir,cobranca,fornecedor,receita,despesa,conciliacao,extrato,antifraude,semana,titulo,titulos,parcela,parcelas,favorecido,conta bancaria,periodo,devedor,devedores,cliente,clientes,recomend',
  [FINANCEIRA_KEYS.forbidPay]: 'pague,faca o pagamento,fazer o pagamento,efetue o pagamento,efetuar o pagamento,realize o pagamento,realizar o pagamento,quite,quitar,mande pagar,mandar pagar,transfira,transferir,pagar agora',
  [FINANCEIRA_KEYS.forbidSettle]: 'liquide,liquidar,de baixa,dar baixa,baixe o titulo,baixar o titulo,marque como pago,marcar como pago,marque como liquidado',
  [FINANCEIRA_KEYS.forbidPayee]: 'altere o favorecido,alterar o favorecido,alterar favorecido,troque o favorecido,trocar o favorecido,mude o favorecido,mudar o favorecido',
  [FINANCEIRA_KEYS.forbidBankAccount]: 'altere a conta bancaria,alterar a conta bancaria,alterar conta bancaria,troque a conta bancaria,trocar a conta bancaria,mude a conta bancaria,mudar a conta bancaria,altere os dados bancarios,alterar os dados bancarios,altere o pix,alterar o pix',
  [FINANCEIRA_KEYS.forbidClosePeriod]: 'feche o periodo,fechar o periodo,fechar periodo,encerre o periodo,encerrar o periodo,feche o mes,fechar o mes,fechamento do periodo',
  [FINANCEIRA_KEYS.forbidCreateEntry]: 'crie um lancamento,criar um lancamento,criar lancamento,crie lancamento,registre um lancamento,registrar um lancamento,inclua um lancamento,incluir um lancamento',
});

const FINANCEIRA_SETTINGS_SCHEMA = {
  [FINANCEIRA_KEYS.anomaliesMax]: { type: 'integer', min: 1, max: 200 },
  [FINANCEIRA_KEYS.suggestionsMax]: { type: 'integer', min: 1, max: 50 },
  [FINANCEIRA_KEYS.renegotiateAfterDays]: { type: 'integer', min: 1, max: 365 },
  [FINANCEIRA_KEYS.scopeTerms]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidPay]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidSettle]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidPayee]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidBankAccount]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidClosePeriod]: { type: 'string' },
  [FINANCEIRA_KEYS.forbidCreateEntry]: { type: 'string' },
};

module.exports = { FINANCEIRA_KEYS, FINANCEIRA_SETTING_DEFAULTS, FINANCEIRA_SETTINGS_SCHEMA };
