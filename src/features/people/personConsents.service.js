'use strict';

const { CommunicationConsent, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const VALID_CHANNELS = ['PHONE', 'WHATSAPP', 'EMAIL'];
const VALID_STATUSES = ['OPT_IN', 'OPT_OUT'];

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

/**
 * Porta do opt-out (M9-D419): quem trata a saída da pessoa (Marketing: supressão, cancelamento do agendado e o evento
 * customer.opted_out) se registra aqui. Pessoas não conhece o Marketing; sem ninguém registrado, o OPT_OUT só fica gravado.
 */
let optOutHandler = null;

function registerOptOutHandler(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('O tratador de opt-out deve ser uma função.');
  optOutHandler = fn;
}

/**
 * recordConsent — registra um novo estado de opt-in/opt-out (CRMX-008: "Comunicação respeita
 * opt-in/opt-out e finalidade"). Cada chamada cria um novo registro (histórico append-only) em
 * vez de sobrescrever o anterior, para preservar a trilha de consentimento ao longo do tempo.
 */
async function recordConsent(personId, payload, actorUserId, transaction, options = {}) {
  const person = await assertPersonExists(personId, transaction);
  const { channel, purpose, status } = payload;
  const normalizedChannel = String(channel || '').toUpperCase();
  const normalizedStatus = String(status || '').toUpperCase();
  if (!VALID_CHANNELS.includes(normalizedChannel)) {
    throw AppError.badRequest(`O campo "channel" deve ser um de: ${VALID_CHANNELS.join(', ')}.`, 'PERSON_CONSENT_VALIDATION');
  }
  if (!purpose) {
    throw AppError.badRequest('O campo "purpose" é obrigatório.', 'PERSON_CONSENT_VALIDATION');
  }
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${VALID_STATUSES.join(', ')}.`, 'PERSON_CONSENT_VALIDATION');
  }

  const consent = await CommunicationConsent.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      channel: normalizedChannel,
      purpose: String(purpose).toUpperCase(),
      status: normalizedStatus,
      recordedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  // Quem registrou, o quê e quando: o consentimento é histórico append-only e cada mudança de estado deixa a linha de auditoria.
  await registrarAuditoria(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      actorUserId,
      action: 'people.consent.record',
      entityType: 'CommunicationConsent',
      entityId: consent.id,
      beforeJson: null,
      afterJson: { personId, channel: normalizedChannel, purpose: String(purpose).toUpperCase(), status: normalizedStatus },
      reason: normalizedStatus === 'OPT_OUT' ? 'Pessoa deixou de aceitar comunicação neste canal e finalidade (opt-out).' : 'Pessoa aceitou comunicação neste canal e finalidade (opt-in).',
    },
    transaction
  );
  // OPT_OUT (M9-D419): na MESMA transação, o Marketing cria a supressão, cancela o agendado e emite customer.opted_out. Quem já é o
  // serviço do opt-out (a supressão do Marketing) registra o consentimento com skipOptOutHandler para não entrar em laço.
  if (normalizedStatus === 'OPT_OUT' && optOutHandler && !options.skipOptOutHandler) {
    await optOutHandler({ person, consent, actorUserId: actorUserId || null }, transaction);
  }
  return consent;
}

async function listConsents(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return CommunicationConsent.findAll({ where: { personId }, order: [['recorded_at', 'DESC']], transaction });
}

/**
 * resolveConsent — devolve o estado de consentimento MAIS RECENTE para (personId, channel,
 * purpose). `communication_consents` é append-only (recordConsent nunca sobrescreve), então
 * "o estado atual" é sempre a última linha por recorded_at — exatamente o mesmo critério já
 * usado por listConsents (ORDER BY recorded_at DESC).
 */
async function resolveConsent(personId, channel, purpose, transaction) {
  const normalizedChannel = String(channel || '').toUpperCase();
  const normalizedPurpose = String(purpose || '').toUpperCase();
  return CommunicationConsent.findOne({
    where: { personId, channel: normalizedChannel, purpose: normalizedPurpose },
    order: [['recorded_at', 'DESC']],
    transaction,
  });
}

/**
 * canContact(person, channel, purpose) — Caderno Pessoas/Imóveis/CRM/Radar, Guia do Marcelo
 * §11 ("Consentimento"):
 *
 *   function canContact(person, channel, purpose) {
 *       const consent = consentRepo.resolve(person.id, channel, purpose);
 *       if (consent.status === 'OPT_OUT') return false;
 *       if (purposeRequiresConsent(purpose) && consent.status !== 'OPT_IN') return false;
 *       return true;
 *   }
 *
 * E §18 ("O que Marcelo NÃO pode improvisar"): "❌ Não ignorar opt-out." + CRM-TS-009
 * ("Opt-out — Cadência tenta enviar — Bloqueado.").
 *
 * Esta é a primeira implementação REAL de bloqueio ATIVO — até aqui
 * personConsents.service.js só registrava o histórico (CommunicationConsent), sem nenhum
 * ponto de disparo consultando esse histórico antes de enviar. `canContact` é o gate; quem
 * dispara mensagem/cadência (messages.service.js, jobs de cadência) deve chamá-lo ANTES de
 * criar o envio.
 *
 * Regra de bloqueio (fail-closed para OPT_OUT, mas não fail-closed para ausência de registro):
 *   - OPT_OUT explícito (em QUALQUER finalidade que não seja a checada, OU na própria
 *     finalidade) vence sempre — "opt-out/suppression vence" (§8 do módulo Comunicação,
 *     mesmo princípio do canSend). Se a pessoa pediu para não ser contatada por aquele canal
 *     em QUALQUER finalidade (ex.: um OPT_OUT geral/'ALL'), bloqueia também finalidades
 *     específicas.
 *   - Sem nenhum registro de consentimento: finalidades que EXIGEM opt-in explícito (ex.:
 *     MARKETING — comunicação promocional) ficam bloqueadas por ausência de OPT_IN; demais
 *     finalidades operacionais (ex.: TRANSACTIONAL — aviso de visita agendada) são permitidas
 *     por padrão, pois o Caderno só exige consentimento explícito para contato de alto
 *     impacto/marketing ("Não envia mensagem de alto impacto sem regras/consentimento.").
 *
 * M3-18 (CRMX-008 "Comunicação respeita opt-in/opt-out e finalidade"): quais finalidades exigem OPT_IN deixou de ser lista fixa no
 * código e passou a ser a LISTA ÚNICA de finalidades da empresa (parâmetros `marketing.consent.exige_opt_in_para` e
 * `marketing.consent.sem_opt_in_para`, M9-D418, aba Marketing de Configurações), entregue por uma porta (Pessoas não conhece o
 * Marketing): o CRM registra a política em `crm/messagePurpose.js`. Finalidade fora das duas listas, ou sem política registrada,
 * nunca autoriza o contato (fail closed).
 */
let purposePolicy = null;

/** Porta da política de finalidades: fn(purpose, tenant, transaction) -> { known, requiresOptIn }. */
function registerPurposePolicy(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('A política de finalidades deve ser uma função.');
  purposePolicy = fn;
}

/** A finalidade exige OPT_IN? true/false; null quando a finalidade não é conhecida (ou não há política registrada). */
async function purposeRequiresConsent(purpose, tenant, transaction) {
  if (!purposePolicy) return null;
  const policy = await purposePolicy(String(purpose || '').toUpperCase(), tenant, transaction);
  return policy && policy.known ? Boolean(policy.requiresOptIn) : null;
}

async function canContact(person, channel, purpose, transaction) {
  if (!person || !person.id) return false;
  const normalizedChannel = String(channel || '').toUpperCase();
  const normalizedPurpose = String(purpose || '').toUpperCase();

  // OPT_OUT na MESMA finalidade bloqueia sempre.
  const specificConsent = await resolveConsent(person.id, normalizedChannel, normalizedPurpose, transaction);
  if (specificConsent && specificConsent.status === 'OPT_OUT') return false;

  // OPT_OUT geral (purpose='ALL') no mesmo canal também bloqueia qualquer finalidade — "Cliente
  // que pediu para não receber contato tem cadências suspensas" (Guia do Marcelo §11).
  const generalOptOut = await resolveConsent(person.id, normalizedChannel, 'ALL', transaction);
  if (generalOptOut && generalOptOut.status === 'OPT_OUT') return false;

  const requiresOptIn = await purposeRequiresConsent(normalizedPurpose, { groupId: person.groupId, companyId: person.companyId }, transaction);
  if (requiresOptIn === null) return false; // finalidade desconhecida: nunca autoriza
  if (requiresOptIn && (!specificConsent || specificConsent.status !== 'OPT_IN')) {
    return false;
  }

  return true;
}

module.exports = {
  recordConsent,
  registerOptOutHandler,
  listConsents,
  resolveConsent,
  canContact,
  purposeRequiresConsent,
  registerPurposePolicy,
  VALID_CHANNELS,
  VALID_STATUSES,
};
