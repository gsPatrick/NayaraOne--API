'use strict';

const AppError = require('../../utils/AppError');
const { registerPurposePolicy } = require('../people/personConsents.service');
const { readPurposeLists } = require('../marketing/suppression/suppression.settings');

/**
 * Finalidade da comunicação no CRM (M3-18; livro do Marco 3 §2 CRMX-008 "Comunicação respeita opt-in/opt-out e finalidade", Guia §11
 * `canContact(person, channel, purpose)`, §12 "Contato externo só usa canal permitido/consentido"). Antes, mensagem sem finalidade
 * virava TRANSACTIONAL e um opt-out só de marketing era contornado omitindo a finalidade. Agora:
 *   - com o parâmetro crm.mensagens.finalidade_obrigatoria LIGADO, toda mensagem SAÍDA para pessoa identificada declara a finalidade
 *     (422 MESSAGE_PURPOSE_REQUIRED). DESLIGADO (comportamento do Marco 9 entregue): sem finalidade, a mensagem segue e o
 *     consentimento é conferido como TRANSACTIONAL;
 *   - LIGADO, a finalidade precisa estar na lista única da empresa (`marketing.consent.exige_opt_in_para` / `marketing.consent.sem_opt_in_para`,
 *     M9-D418, aba Marketing de Configurações): fora dela, 422 MESSAGE_PURPOSE_UNKNOWN e nada é gravado nem enviado; e a mesma lista diz
 *     se a finalidade exige OPT_IN no `canContact` (porta registrada abaixo);
 *   - DESLIGADO, tudo como no Marco 9: qualquer finalidade é aceita e só MARKETING, CADENCE e CAMPAIGN exigem OPT_IN no `canContact`.
 * Padrão LIGADO desde 16/11/2026 (decisão do Patrick: o livro manda).
 */
const PURPOSE_RE = /^[A-Z0-9_]{2,40}$/;

// Marco 9 entregue (personConsents.canContact): fora das listas da empresa, só estas exigem OPT_IN; as demais seguem sem OPT_IN.
const MARCO9_OPT_IN = new Set(['MARKETING', 'CADENCE', 'CAMPAIGN']);
// Finalidades que o PRÓPRIO sistema oferece (Marco 9: canContact; NAY Comercial, `ia.comercial.envio.finalidade_consentimento`) continuam
// reconhecidas com a regra ligada mesmo que a empresa não as tenha posto nas listas: as de contato comercial exigem OPT_IN (conservador,
// CRMX-008) e a de serviço não exige. As listas da empresa vêm primeiro e podem reclassificar.
const SISTEMA_OPT_IN = new Set([...MARCO9_OPT_IN, 'COMMERCIAL']);
const SISTEMA_SEM_OPT_IN = new Set(['TRANSACTIONAL']);
const purposeRequired = (tenant, transaction) => require('./crm.params').readPurposeRequired(tenant, transaction);

async function classify(purpose, tenant, transaction) {
  // Parâmetro crm.mensagens.finalidade_obrigatoria desligado: exatamente o Marco 9 entregue (só MARKETING, CADENCE e CAMPAIGN exigem
  // OPT_IN; toda finalidade é aceita). Ligado (o padrão, M3-18): valem as listas da empresa e, depois delas, as finalidades do sistema.
  if (!(await purposeRequired(tenant, transaction))) return { known: true, requiresOptIn: MARCO9_OPT_IN.has(purpose) };
  const { requireOptIn, noOptIn } = await readPurposeLists(tenant, transaction);
  if (requireOptIn.includes(purpose)) return { known: true, requiresOptIn: true };
  if (noOptIn.includes(purpose)) return { known: true, requiresOptIn: false };
  if (SISTEMA_OPT_IN.has(purpose)) return { known: true, requiresOptIn: true };
  if (SISTEMA_SEM_OPT_IN.has(purpose)) return { known: true, requiresOptIn: false };
  return { known: false, requiresOptIn: true, known_purposes: [...new Set([...requireOptIn, ...noOptIn, ...SISTEMA_OPT_IN, ...SISTEMA_SEM_OPT_IN])] };
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
    if (!(await purposeRequired(tenant, transaction))) return null;
    throw AppError.unprocessable('Informe a finalidade da mensagem (por exemplo, TRANSACTIONAL ou MARKETING): sem finalidade o envio não é feito.', 'MESSAGE_PURPOSE_REQUIRED', { field: 'purpose' });
  }
  const policy = PURPOSE_RE.test(normalized) ? await classify(normalized, tenant, transaction) : { known: false, known_purposes: [] };
  if (!policy.known) {
    throw AppError.unprocessable('Finalidade de mensagem não reconhecida: use uma das finalidades cadastradas em Configurações.', 'MESSAGE_PURPOSE_UNKNOWN', { purpose: normalized, conhecidas: policy.known_purposes });
  }
  return normalized;
}

module.exports = { resolveOutboundPurpose, classifyPurpose: classify };
