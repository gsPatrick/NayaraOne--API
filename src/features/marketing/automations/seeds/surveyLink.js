'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { SURVEY_LINK_KEY } = require('./cadence.settings');
const { checkUrl } = require('./ports');

/**
 * Provedor do link da pesquisa de satisfação (`SATISFACTION_LINK`). A pesquisa e a captura da nota são do CRM; o Marketing só leva o endereço configurado pelo administrador
 * (`marketing.pos_chaves.link_pesquisa`), validado pela regra de URL externa. Sem endereço, ou com endereço recusado, devolve null e a mensagem não sai.
 */
async function surveyLink({ tenant, transaction }) {
  const raw = await getSetting(SURVEY_LINK_KEY, tenant, transaction, '');
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return await checkUrl(raw, { tenant, transaction });
  } catch (err) {
    return null;
  }
}

module.exports = { surveyLink };
