'use strict';

const { normalize } = require('./atendimento.params');

/**
 * Triagem da mensagem do cliente (M9-D041), regra do servidor sobre listas de termos que o administrador configura (ia.atendimento.termos_*).
 * Ordem, a primeira que se aplica vence: dado de outro cliente (recusa), envio por canal externo e pedido fora da política (encaminha a
 * uma pessoa), anúncios (lista por regra, sem modelo) e, por último, a dúvida simples que a política homologada responde.
 */
const CATEGORIES = Object.freeze({
  OUTRO_CLIENTE: 'OUTRO_CLIENTE', CANAL_EXTERNO: 'CANAL_EXTERNO', FORA_DA_POLITICA: 'FORA_DA_POLITICA', ANUNCIOS: 'ANUNCIOS', DUVIDA: 'DUVIDA',
});

/** Tipo de tarefa de cada categoria: as quatro primeiras são resolvidas por regra (sem modelo); a dúvida vai ao modelo pequeno (`triar`). */
const TASK_TYPES = Object.freeze({
  OUTRO_CLIENTE: 'atendimento_recusar', CANAL_EXTERNO: 'atendimento_encaminhar', FORA_DA_POLITICA: 'atendimento_encaminhar', ANUNCIOS: 'atendimento_listar_anuncios', DUVIDA: 'triar',
});

/** Motivo do encaminhamento (`topic` da tool crm.createHandoffTask) de cada categoria que encaminha. */
const HANDOFF_TOPICS = Object.freeze({ CANAL_EXTERNO: 'CANAL_EXTERNO', FORA_DA_POLITICA: 'FORA_DA_POLITICA' });

const hasAny = (texto, termos) => termos.some((t) => texto.includes(t));

/** `params` vem de loadAtendimentoParams. Devolve { category, taskType, handoffTopic|null }. */
function classifyMessage(message, params) {
  const texto = normalize(message);
  let category = CATEGORIES.DUVIDA;
  if (hasAny(texto, params.termosOutroCliente)) category = CATEGORIES.OUTRO_CLIENTE;
  else if (hasAny(texto, params.termosCanalExterno)) category = CATEGORIES.CANAL_EXTERNO;
  else if (hasAny(texto, params.termosForaDaPolitica)) category = CATEGORIES.FORA_DA_POLITICA;
  else if (hasAny(texto, params.termosAnuncios)) category = CATEGORIES.ANUNCIOS;
  return { category, taskType: TASK_TYPES[category], handoffTopic: HANDOFF_TOPICS[category] || null };
}

/** A resposta do modelo faz promessa em nome da empresa (algum termo de ia.atendimento.termos_promessa)? */
const promisesSomething = (answer, params) => hasAny(normalize(answer), params.termosPromessa);

module.exports = { CATEGORIES, TASK_TYPES, HANDOFF_TOPICS, classifyMessage, promisesSomething };
