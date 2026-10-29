'use strict';

/**
 * Parâmetros da NAY Correspondente (M9-D039), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * O limiar de "caso parado" NÃO está aqui: é o `stalledCaseDays` que o Correspondente já tem nos seus parâmetros (padrão 7 dias).
 * As listas de termos são texto separado por vírgula (sem acento, sem diferenciar maiúsculas) e servem à fronteira do agente
 * (agents/scope) e à troca da resposta que promete o que o agente não pode prometer. Os dois limites existem porque o livro não diz
 * quantos itens a resposta lista; o padrão é conservador.
 */
const CORRESPONDENTE_KEYS = Object.freeze({
  scopeTerms: 'ia.correspondente.termos_escopo',
  forbidCreditDecision: 'ia.correspondente.proibicao.decidir_credito',
  forbidPromiseTerms: 'ia.correspondente.proibicao.prometer_condicoes',
  forbidSendDocument: 'ia.correspondente.proibicao.enviar_documento_banco',
  forbidCallProvider: 'ia.correspondente.proibicao.chamar_provider',
  forbidChangeStatus: 'ia.correspondente.proibicao.alterar_status',
  answerTerms: 'ia.correspondente.termos_resposta_proibida',
  maxStalledCases: 'ia.correspondente.max_casos_parados',
  maxSimulations: 'ia.correspondente.max_simulacoes',
});
const K = CORRESPONDENTE_KEYS;

const CORRESPONDENTE_SETTING_DEFAULTS = Object.freeze({
  [K.scopeTerms]: 'caso,financiamento,financiar,simulacao,simulacoes,pendencia,pendente,documento,exigencia,requisito,checklist,status,etapa,andamento,parado,banco,provider,proposta,correspondente,credito,parcela,taxa,prazo,politica,regra,norma,procedimento,situacao,proponente,imovel',
  [K.forbidCreditDecision]: 'aprovar o credito,aprove o credito,aprovar credito,aprove credito,reprovar o credito,reprove o credito,negar o credito,negue o credito,conceder o credito,conceda o credito,liberar o credito,libere o credito,aprovar o financiamento,aprove o financiamento,reprovar o financiamento,reprove o financiamento,sera aprovado,sera aprovada,vai ser aprovado,vai ser aprovada,sera reprovado,sera reprovada,sera negado,sera negada,vai conseguir o financiamento,vai conseguir o credito,vai conseguir aprovar,chance de aprovacao,chances de aprovacao,probabilidade de aprovacao,devo aprovar,posso aprovar,classifique o credito,classificar o credito,avalie o credito,avaliar o credito,analise o credito,analisar o credito,score de credito',
  [K.forbidPromiseTerms]: 'prometa,prometer,promete,garanta,garantir,assegure,simule,simular,estime,estimar,calcule a parcela,calcular a parcela,calcule a taxa,calcule o prazo,qual taxa vou conseguir,qual a taxa que vou,qual taxa o cliente vai,qual sera a taxa,qual sera a parcela,qual sera o prazo,quanto vai ficar a parcela,quanto ficara a parcela,taxa que vou conseguir,taxa que ele vai conseguir,taxa que o cliente vai conseguir,projete a parcela,projetar a parcela,preveja a taxa',
  [K.forbidSendDocument]: 'enviar ao banco,envie ao banco,enviar para o banco,envie para o banco,mandar ao banco,mande ao banco,mandar para o banco,mande para o banco,enviar o documento ao,envie o documento ao,enviar documento ao,envie documento ao,enviar os documentos ao,envie os documentos ao,enviar o caso ao,envie o caso ao,submeter o caso,submeta o caso,submeter a proposta,submeta a proposta,protocolar no banco,protocole no banco,encaminhar ao banco,encaminhe ao banco,encaminhar para o banco,encaminhe para o banco,envie o documento,enviar o documento,envie os documentos,enviar os documentos,envie documento,enviar documento,mande o documento,mandar o documento,mande os documentos,mandar os documentos,envie a documentacao,enviar a documentacao,envie o caso,enviar o caso,envie a proposta,enviar a proposta,submeta,submeter,protocole,protocolar',
  [K.forbidCallProvider]: 'chame o provider,chamar o provider,chame o provedor,chamar o provedor,acione o provider,acionar o provider,acione o banco,acionar o banco,consulte o provider,consultar o provider,consulte o provedor,consulte o banco,consultar o banco,ligue para o banco,ligar para o banco,contate o banco,contatar o banco',
  [K.forbidChangeStatus]: 'alterar o status,altere o status,mudar o status,mude o status,atualizar o status,atualize o status,avancar o status,avance o status,definir o status,defina o status,alterar a etapa,altere a etapa,mudar a etapa,mude a etapa,avancar o caso,avance o caso,cancelar o caso,cancele o caso,reabrir o caso,reabra o caso,concluir o caso,conclua o caso,marcar o caso como,marque o caso como,colocar o caso em,coloque o caso em,mover o caso,mova o caso',
  [K.answerTerms]: 'sera aprovado,sera aprovada,vai ser aprovado,vai ser aprovada,sera reprovado,sera reprovada,vai ser reprovado,aprovacao garantida,aprovacao certa,aprovacao assegurada,voce vai conseguir,o cliente vai conseguir,ele vai conseguir,ela vai conseguir,o proponente vai conseguir,chance de aprovacao,chances de aprovacao,garanto,garantimos,prometo,prometemos,a taxa sera,sua taxa sera,a parcela sera,sua parcela sera,a taxa vai ficar,a parcela vai ficar,o prazo sera,o prazo vai ser,recomendo aprovar,recomendo a simulacao,recomendo o banco,recomendo a opcao,sugiro aprovar,sugiro a simulacao,melhor opcao de credito',
  [K.maxStalledCases]: 20,
  [K.maxSimulations]: 10,
});

const TERMS = { type: 'string' };
const CORRESPONDENTE_SETTINGS_SCHEMA = {
  [K.scopeTerms]: TERMS,
  [K.forbidCreditDecision]: TERMS,
  [K.forbidPromiseTerms]: TERMS,
  [K.forbidSendDocument]: TERMS,
  [K.forbidCallProvider]: TERMS,
  [K.forbidChangeStatus]: TERMS,
  [K.answerTerms]: TERMS,
  [K.maxStalledCases]: { type: 'integer', min: 1, max: 200 },
  [K.maxSimulations]: { type: 'integer', min: 1, max: 50 },
};

module.exports = { CORRESPONDENTE_KEYS, CORRESPONDENTE_SETTING_DEFAULTS, CORRESPONDENTE_SETTINGS_SCHEMA };
