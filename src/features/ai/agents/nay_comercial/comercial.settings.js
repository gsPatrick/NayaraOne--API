'use strict';

/**
 * Parâmetros da NAY Comercial (M9-D034), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * As listas de termos separam por vírgula (sem acento, sem diferenciar maiúsculas); servem a fronteira do agente (scope.guard.js).
 * `ia.comercial.permitir_propostas` (padrão Desligado, o livro manda "só depois liberar proposals") só liga com avaliação PASSED e
 * homologação humana da versão ativa (settingGuard.js, 409 AI_AGENT_NOT_HOMOLOGATED).
 */
const { SENSITIVE_KEYS, SENSITIVE_SETTING_DEFAULTS, SENSITIVE_SETTINGS_SCHEMA } = require('./comercial.sensitive.settings');
const { CAP_KEYS, CAP_SETTING_DEFAULTS, CAP_SETTINGS_SCHEMA } = require('./comercial.capabilities.settings');

const COMERCIAL_KEYS = Object.freeze({
  daysWithoutContact: 'ia.comercial.dias_sem_contato_alerta',
  daysProposalNoReply: 'ia.comercial.dias_proposta_sem_resposta',
  radarMax: 'ia.comercial.radar_max_imoveis',
  allowProposals: 'ia.comercial.permitir_propostas',
  summaryInteractions: 'ia.comercial.resumo_max_interacoes',
  scopeTerms: 'ia.comercial.termos_escopo',
  forbidCreateTask: 'ia.comercial.proibicao.criar_tarefa',
  forbidChangeStage: 'ia.comercial.proibicao.alterar_etapa',
  forbidSendMessage: 'ia.comercial.proibicao.enviar_mensagem',
  forbidPublish: 'ia.comercial.proibicao.publicar_descricao',
  ...CAP_KEYS,
  forbidInferSensitive: SENSITIVE_KEYS.forbidInfer,
});

const K = COMERCIAL_KEYS;
const COMERCIAL_SETTING_DEFAULTS = Object.freeze({
  [K.daysWithoutContact]: 7,
  [K.daysProposalNoReply]: 5,
  [K.radarMax]: 10,
  [K.allowProposals]: false,
  [K.summaryInteractions]: 5,
  [K.scopeTerms]: 'resum,sugir,sugest,proxima,listar,liste,rascunh,descreva,recuper,retom,oportunidade,oportunidades,cliente,clientes,lead,leads,corretor,funil,pipeline,etapa,contato,interacao,interacoes,proposta,propostas,visita,visitas,radar,imovel,imoveis,follow,retomar,recuperacao,descricao,anuncio,negociacao,documento,documentos pendentes,tarefa,cadastro,classifi,mensagem,sentimento,esquecid,parad,envio',
  [K.forbidCreateTask]: 'crie uma tarefa,criar uma tarefa,crie tarefa,criar tarefa,cria uma tarefa,agende uma tarefa,agendar uma tarefa,crie um follow,criar um follow,crie um lembrete,criar um lembrete,registre uma tarefa,registrar uma tarefa',
  [K.forbidChangeStage]: 'mude a etapa,mudar a etapa,altere a etapa,alterar a etapa,troque a etapa,trocar a etapa,mova a oportunidade,mover a oportunidade,avance a oportunidade,avancar a oportunidade,marque como ganha,marcar como ganha,marque como perdida,marcar como perdida,feche a oportunidade,fechar a oportunidade,arquive a oportunidade,arquivar a oportunidade',
  [K.forbidSendMessage]: 'envie a mensagem,enviar a mensagem,envie uma mensagem,enviar uma mensagem,mande a mensagem,mandar a mensagem,mande uma mensagem,mandar uma mensagem,envie um whatsapp,enviar um whatsapp,mande um whatsapp,envie um e-mail,enviar um e-mail,mande um e-mail,dispare a mensagem,disparar a mensagem',
  [K.forbidPublish]: 'publique a descricao,publicar a descricao,publique o anuncio,publicar o anuncio,atualize o anuncio,atualizar o anuncio,salve a descricao,salvar a descricao,grave a descricao,gravar a descricao',
  ...CAP_SETTING_DEFAULTS,
  ...SENSITIVE_SETTING_DEFAULTS,
});

const COMERCIAL_SETTINGS_SCHEMA = {
  [K.daysWithoutContact]: { type: 'integer', min: 1, max: 365 },
  [K.daysProposalNoReply]: { type: 'integer', min: 1, max: 365 },
  [K.radarMax]: { type: 'integer', min: 1, max: 50 },
  [K.allowProposals]: { type: 'boolean' },
  [K.summaryInteractions]: { type: 'integer', min: 1, max: 20 },
  [K.scopeTerms]: { type: 'string' },
  [K.forbidCreateTask]: { type: 'string' },
  [K.forbidChangeStage]: { type: 'string' },
  [K.forbidSendMessage]: { type: 'string' },
  [K.forbidPublish]: { type: 'string' },
  ...CAP_SETTINGS_SCHEMA,
  ...SENSITIVE_SETTINGS_SCHEMA,
};

module.exports = { COMERCIAL_KEYS, COMERCIAL_SETTING_DEFAULTS, COMERCIAL_SETTINGS_SCHEMA };
