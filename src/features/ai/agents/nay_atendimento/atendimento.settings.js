'use strict';

/**
 * Parâmetros da NAY Atendimento (M9-D041), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv. As listas de termos são texto
 * separado por vírgula (mesmo padrão de ia.seguranca.termos_segredo_extra); comparação sem caixa e sem acento.
 *  - papel_handoff: papel (nome) cuja pessoa recebe o encaminhamento; vazio ou papel sem membro ativo deixa o encaminhamento sem destinatário;
 *  - termos_fora_da_politica / termos_canal_externo / termos_outro_cliente / termos_anuncios: a triagem da mensagem do cliente;
 *  - termos_promessa: trechos que a resposta do modelo não pode conter (promessa em nome da empresa);
 *  - mensagem_*: os textos fixos (encaminhamento, fora do escopo e resposta com promessa trocada) que o cliente lê; max_anuncios: tamanho da lista de anúncios.
 */
const ATENDIMENTO_KEYS = Object.freeze({
  papelHandoff: 'ia.atendimento.papel_handoff',
  termosForaDaPolitica: 'ia.atendimento.termos_fora_da_politica',
  termosCanalExterno: 'ia.atendimento.termos_canal_externo',
  termosOutroCliente: 'ia.atendimento.termos_outro_cliente',
  termosAnuncios: 'ia.atendimento.termos_anuncios',
  termosPromessa: 'ia.atendimento.termos_promessa',
  mensagemEncaminhamento: 'ia.atendimento.mensagem_encaminhamento',
  mensagemForaDoEscopo: 'ia.atendimento.mensagem_fora_do_escopo',
  mensagemSemPromessa: 'ia.atendimento.mensagem_sem_promessa',
  maxAnuncios: 'ia.atendimento.max_anuncios',
});

const ATENDIMENTO_SETTING_DEFAULTS = Object.freeze({
  [ATENDIMENTO_KEYS.papelHandoff]: 'atendimento',
  [ATENDIMENTO_KEYS.termosForaDaPolitica]: 'desconto,abatimento,renegociar,renegociação,parcelar,parcelamento,prazo,multa,juros,isenção,rescisão,reembolso,acordo,condição especial,negociar',
  [ATENDIMENTO_KEYS.termosCanalExterno]: 'envie um whatsapp,envie uma mensagem,mande um whatsapp,mande uma mensagem,mande um e-mail,envie um e-mail,enviar sms,dispare',
  [ATENDIMENTO_KEYS.termosOutroCliente]: 'outro cliente,outra pessoa,meu vizinho,dados de terceiro,contrato de outro,do inquilino,do proprietário',
  [ATENDIMENTO_KEYS.termosAnuncios]: 'anúncios,anuncios,imóveis disponíveis,imoveis disponiveis,imóveis à venda,imóveis para alugar,o que vocês têm,casas à venda,apartamentos para alugar',
  [ATENDIMENTO_KEYS.termosPromessa]: 'prometo,garanto,garantimos,fica combinado,pode contar que,eu te dou,vamos dar desconto,conseguimos fazer por',
  [ATENDIMENTO_KEYS.mensagemEncaminhamento]: 'Registrei o seu pedido e um atendente da equipe vai retornar para você. Não posso informar valores, descontos, prazos ou condições por aqui.',
  [ATENDIMENTO_KEYS.mensagemForaDoEscopo]: 'Isso foge do que este assistente pode fazer.',
  [ATENDIMENTO_KEYS.mensagemSemPromessa]: 'Não posso assumir compromissos em nome da empresa. Um atendente pode confirmar isso com você.',
  [ATENDIMENTO_KEYS.maxAnuncios]: 5,
});

const AppError = require('../../../../utils/AppError');

const texto = (max) => ({
  type: 'string',
  validate: (key, value) => {
    if (value.length > max) throw AppError.badRequest(`O valor de "${key}" deve ter até ${max} caracteres.`, 'SETTING_INVALID_VALUE', { key, max });
  },
});

const ATENDIMENTO_SETTINGS_SCHEMA = {
  [ATENDIMENTO_KEYS.papelHandoff]: texto(100),
  [ATENDIMENTO_KEYS.termosForaDaPolitica]: texto(2000),
  [ATENDIMENTO_KEYS.termosCanalExterno]: texto(2000),
  [ATENDIMENTO_KEYS.termosOutroCliente]: texto(2000),
  [ATENDIMENTO_KEYS.termosAnuncios]: texto(2000),
  [ATENDIMENTO_KEYS.termosPromessa]: texto(2000),
  [ATENDIMENTO_KEYS.mensagemEncaminhamento]: texto(500),
  [ATENDIMENTO_KEYS.mensagemForaDoEscopo]: texto(300),
  [ATENDIMENTO_KEYS.mensagemSemPromessa]: texto(300),
  [ATENDIMENTO_KEYS.maxAnuncios]: { type: 'integer', min: 1, max: 20 },
};

module.exports = { ATENDIMENTO_KEYS, ATENDIMENTO_SETTING_DEFAULTS, ATENDIMENTO_SETTINGS_SCHEMA };
