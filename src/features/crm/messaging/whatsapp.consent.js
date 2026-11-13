'use strict';

const { Person } = require('../../../models');
const { canContact, resolveConsent } = require('../../people/personConsents.service');
require('../messagePurpose'); // M3-18: registra a política de finalidades (lista única) que o canContact consulta
const E = require('./whatsapp.errors');

const CHANNEL = 'WHATSAPP';
const PURPOSE_MARKETING = 'MARKETING';

const finalidade = (p) => String(p || 'TRANSACTIONAL').toUpperCase();

/**
 * O contato pode receber esta mensagem agora? (M9-D230 3.2). GRANTED = OPT_IN e REVOKED = OPT_OUT do cadastro de consentimentos. Vale o OPT_OUT da finalidade ou do canal inteiro (palavra de saída);
 * marketing exige o OPT_IN de marketing; o transacional exige OPT_IN só se a empresa pedir (`transactional_requires_opt_in`). Mensagem sem pessoa identificada não prova consentimento: só o
 * transacional sai, e só com o parâmetro desligado.
 */
async function consentAllowed(personId, purpose, params, transaction) {
  const fin = finalidade(purpose);
  const exigeOptIn = fin === PURPOSE_MARKETING || params.transactionalRequiresOptIn;
  if (!personId) return !exigeOptIn;
  const pessoa = await Person.findByPk(personId, { transaction });
  if (!pessoa) return false;
  if (!(await canContact(pessoa, CHANNEL, fin, transaction))) return false;
  if (!params.transactionalRequiresOptIn) return true;
  const registro = await resolveConsent(personId, CHANNEL, fin, transaction);
  return Boolean(registro) && registro.status === 'OPT_IN';
}

/** No ENFILEIRAMENTO: recusa com 403 e nada é enfileirado. */
async function assertConsent(personId, purpose, params, transaction) {
  if (!(await consentAllowed(personId, purpose, params, transaction))) throw E.noConsent(finalidade(purpose));
}

module.exports = { consentAllowed, assertConsent, CHANNEL };
