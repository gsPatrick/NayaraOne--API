'use strict';

const AppError = require('../../utils/AppError');
const { registerPurposePolicy } = require('../people/personConsents.service');
const { readPurposeLists } = require('../marketing/suppression/suppression.settings');

/**
 * Finalidade da comunicação no CRM (M3-18; livro do Marco 3 §2 CRMX-008 "Comunicação respeita opt-in/opt-out e finalidade", Guia §11
 * `canContact(person, channel, purpose)`, §12 "Contato externo só usa canal permitido/consentido"). Antes, mensagem sem finalidade
 * virava TRANSACTIONAL e um opt-out só de marketing era contornado omitindo a finalidade. Agora:
 *   - com o parâmetro crm.mensagens.finalidade_obrigatoria LIGADO, toda mensagem SAÍDA para pessoa identificada declara a finalidade
 *     (422 MESSAGE_PURPOSE_REQUIRED). DESLIGADO (o padrão, comportamento do Marco 9 entregue): sem finalidade, a mensagem segue e o
 *     consentimento é conferido como TRANSACTIONAL;
 *   - a finalidade precisa estar na lista única da empresa (`marketing.consent.exige_opt_in_para` / `marketing.consent.sem_opt_in_para`,
 *     M9-D418, aba Marketing de Configurações); fora dela, 422 MESSAGE_PURPOSE_UNKNOWN e nada é gravado nem enviado;
 *   - a mesma lista diz se a finalidade exige OPT_IN no `canContact` (porta registrada abaixo), sem lista fixa no código.
 */
const PURPOSE_RE = /^[A-Z0-9_]{2,40}$/;

async function classify(purpose, tenant, transaction) {
  const { requireOptIn, noOptIn } = await readPurposeLists(tenant, transaction);
  if (requireOptIn.includes(purpose)) return { known: true, requiresOptIn: true };
  if (noOptIn.includes(purpose)) return { known: true, requiresOptIn: false };
  return { known: false, requiresOptIn: true, known_purposes: [...requireOptIn, ...noOptIn] };
}

registerPurposePolicy(classify);

/**
 * Finalidade normalizada de uma mensagem SAÍDA para pessoa identificada, ou de um envio pelo fornecedor (`required`); mensagem
 * recebida ou sem pessoa devolve a informada, normalizada, ou null. `tenant`: { groupId, companyId }.
 */
async function resolveOutboundPurpose({ direction, personId, purpose, required = false }, tenant, transaction) {
  const normalized = purpose === undefined || purpose === null ? '' : String(purpose).trim().toUpperCase();
  if (!required && (direction !== 'OUTBOUND' || !personId)) return normalized && PURPOSE_RE.test(normalized) ? normalized : null;
  if (!normalized) {
    if (!(await require('./crm.params').readPurposeRequired(tenant, transaction))) return null;
    throw AppError.unprocessable('Informe a finalidade da mensagem (por exemplo, TRANSACTIONAL ou MARKETING): sem finalidade o envio não é feito.', 'MESSAGE_PURPOSE_REQUIRED', { field: 'purpose' });
  }
  const policy = PURPOSE_RE.test(normalized) ? await classify(normalized, tenant, transaction) : { known: false, known_purposes: [] };
  if (!policy.known) {
    throw AppError.unprocessable('Finalidade de mensagem não reconhecida: use uma das finalidades cadastradas em Configurações.', 'MESSAGE_PURPOSE_UNKNOWN', { purpose: normalized, conhecidas: policy.known_purposes });
  }
  return normalized;
}

module.exports = { resolveOutboundPurpose, classifyPurpose: classify };
