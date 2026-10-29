'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { COMERCIAL_KEYS: K, COMERCIAL_SETTING_DEFAULTS: D } = require('./comercial.settings');

async function readInt(key, tenant, transaction) {
  const value = await getSetting(key, tenant, transaction, D[key]);
  return Number.isInteger(value) && value >= 1 ? value : D[key];
}

/** Lê, a cada consulta, os parâmetros numéricos da NAY Comercial (valor inválido volta ao padrão do livro). */
async function readComercialParams(tenant, transaction) {
  return {
    daysWithoutContact: await readInt(K.daysWithoutContact, tenant, transaction),
    daysProposalNoReply: await readInt(K.daysProposalNoReply, tenant, transaction),
    radarMax: await readInt(K.radarMax, tenant, transaction),
    summaryInteractions: await readInt(K.summaryInteractions, tenant, transaction),
  };
}

/** A empresa liberou a proposta de tarefa de follow-up? Padrão Desligado; só liga com a versão ativa avaliada e homologada. */
async function proposalsAllowed(tenant, transaction) {
  return (await getSetting(K.allowProposals, tenant, transaction, D[K.allowProposals])) === true;
}

module.exports = { readComercialParams, proposalsAllowed };
