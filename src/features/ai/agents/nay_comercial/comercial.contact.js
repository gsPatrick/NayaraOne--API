'use strict';

// Livro do Marco 3 §16: "Não envia mensagem de alto impacto sem regras/consentimento" (e §12 "Contato externo só usa canal
// permitido/consentido"; Guia §11 canContact). Capacidade `propor_envio_mensagem`: a NAY NUNCA envia. Ela confere as regras do contato
// (canal com contato cadastrado e canContact da pessoa no canal e na finalidade do parâmetro `ia.comercial.envio.finalidade_consentimento`)
// e, só quando tudo permite, prepara o rascunho como PROPOSTA de envio para a pessoa revisar e enviar pelo CRM (recomendação sem ação
// executável: aceitar só marca como vista; o envio é da pessoa, pela tela de mensagens, que confere o consentimento de novo). Sem regra
// ou sem consentimento: recusa com o motivo e nada é registrado como proposta. Toda mensagem ao cliente redigida pela NAY é tratada como de
// alto impacto (DI-M3CB-26).
const { Person, PersonContact } = require('../../../../models');
const { canContact } = require('../../../people/personConsents.service');
const { semAcento } = require('../../orchestrator/numbers/decimalText');
const { readSendParams } = require('./comercial.capParams');
const { recoveryDraft, BANNER } = require('./comercial.drafts');

const CONTACT_TYPES = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], SMS: ['PHONE', 'WHATSAPP'], PHONE: ['PHONE', 'WHATSAPP'], EMAIL: ['EMAIL'] });
const CHANNEL_LABEL = Object.freeze({ WHATSAPP: 'WhatsApp', SMS: 'SMS', PHONE: 'telefone', EMAIL: 'e-mail' });
const NOTHING_SENT = 'Nenhuma mensagem foi enviada.';

/** Canal pedido no texto ("por e-mail", "por SMS"...) ou o padrão da empresa. */
function channelOf(input, fallback) {
  const t = semAcento(String(input || ''));
  if (/\be-?mail\b/.test(t)) return 'EMAIL';
  if (/\bsms\b/.test(t)) return 'SMS';
  if (/\bwhats ?app\b|\bzap\b/.test(t)) return 'WHATSAPP';
  if (/\btelefone\b|\bligacao\b|\bligar\b/.test(t)) return 'PHONE';
  return fallback;
}

/** Regras do envio: { allowed, reason, channel, purpose }. Lê o consentimento com a mesma função do envio do CRM (canContact). */
async function contactRules(personId, channel, purpose, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) return { allowed: false, reason: 'o cliente não foi encontrado no cadastro', channel, purpose };
  const contacts = await PersonContact.findAll({ where: { personId, contactType: CONTACT_TYPES[channel] }, transaction });
  if (!contacts.length) return { allowed: false, reason: `o cliente não tem contato de ${CHANNEL_LABEL[channel]} cadastrado`, channel, purpose };
  if (!(await canContact(person, channel, purpose, transaction))) {
    return { allowed: false, reason: `o cliente não autorizou contato por ${CHANNEL_LABEL[channel]} para a finalidade ${purpose} (ou pediu para não ser contatado)`, channel, purpose };
  }
  return { allowed: true, reason: null, channel, purpose };
}

/** Resultado do caminho de regra a partir dos fatos da oportunidade (comercial.data.js). */
async function sendProposalResult(facts, { input, tenant, transaction }) {
  const params = await readSendParams(tenant, transaction);
  const channel = channelOf(input, params.channel);
  const rules = await contactRules(facts.personId, channel, params.purpose, transaction);
  const draft = recoveryDraft(facts);
  const base = { snapshotAt: facts.asOf, sources: draft.sources };
  const structured = { tipo: 'PROPOSTA_ENVIO_MENSAGEM', oportunidade: facts.opportunityId, canal: channel, finalidade: params.purpose, permitido: rules.allowed, motivo: rules.reason, enviada: false };
  if (!rules.allowed) {
    return { ...base, answer: `Não preparei o envio [1]: ${rules.reason}. ${NOTHING_SENT} A NAY não envia mensagem sem as regras de contato e o consentimento do cliente.`, structured, meta: { recommend: false } };
  }
  const text = draft.answer.split('\n').filter((l) => l !== BANNER).slice(1).join('\n');
  return {
    ...base,
    answer: [BANNER, `Proposta de envio por ${CHANNEL_LABEL[channel]} para ${facts.customerName || 'o cliente'} [1] (regras de contato e consentimento conferidos para a finalidade ${params.purpose}):`, text, `${NOTHING_SENT} Revise e envie você pelo CRM.`].join('\n'),
    structured: { ...structured, texto: text },
    meta: {
      recommendation: {
        type: 'PROPOSTA_ENVIO_MENSAGEM', entityType: 'CRM_OPPORTUNITY', entityId: facts.opportunityId, riskLevel: 'MEDIUM',
        title: `Proposta de mensagem por ${CHANNEL_LABEL[channel]} para ${facts.customerName || 'o cliente'}`.slice(0, 200),
        rationale: 'Rascunho de mensagem de recuperação; consentimento conferido. A NAY não envia: o envio é da pessoa, pelo CRM.',
        payload: { canal: channel, finalidade: params.purpose, texto: text, enviada: false, consentimentoConferido: true },
      },
    },
  };
}

module.exports = { sendProposalResult, contactRules, channelOf, NOTHING_SENT };
