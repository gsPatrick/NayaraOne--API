'use strict';

const { mktError } = require('../marketing.errors');
const { readPurposeLists } = require('./suppression.settings');

const normalizePurpose = (purpose) => String(purpose === undefined || purpose === null ? '' : purpose).trim().toUpperCase();

/**
 * Lista única de finalidades (M9-D418): exigem OPT_IN as de `marketing.consent.exige_opt_in_para`; não exigem as de
 * `marketing.consent.sem_opt_in_para`. Qualquer outra é erro de configuração: 422 MKT_PURPOSE_UNKNOWN, nunca envia.
 * Devolve { purpose, requiresOptIn }.
 */
async function classifyPurpose(purpose, tenant, transaction) {
  const normalized = normalizePurpose(purpose);
  const { requireOptIn, noOptIn } = await readPurposeLists(tenant, transaction);
  if (requireOptIn.includes(normalized)) return { purpose: normalized, requiresOptIn: true };
  if (noOptIn.includes(normalized)) return { purpose: normalized, requiresOptIn: false };
  throw mktError(422, 'MKT_PURPOSE_UNKNOWN', 'Finalidade de mensagem não reconhecida.', { purpose: normalized, conhecidas: [...requireOptIn, ...noOptIn] });
}

module.exports = { classifyPurpose, normalizePurpose };
