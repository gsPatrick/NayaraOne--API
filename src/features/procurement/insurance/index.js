'use strict';

/**
 * Seguradoras sobre o framework de integrações (Marco 9, M9-D238): o pedido à seguradora entra pelo Dispatch Service (cotação, proposta e sinistro), o fluxo manual cumpre o mesmo
 * port por tarefas a uma pessoa, a apólice tem versões imutáveis com documento e hash, os marcos de vencimento viram eventos e a renovação pede nova cotação pelo mesmo
 * fornecedor. Ao carregar, liga o tratador dos webhooks de status da apólice. Fachada da API do módulo.
 */
const { callInsurer, proposalKey } = require('./insurance.call');
const { ensureInsuranceConnection, PROVIDER_CODES, providerKeyOf } = require('./insurance.connection');
const { addPolicyVersion, listPolicyVersions, currentVersion } = require('./insurance.versions');
const { completeTask, cancelTask, listTasks } = require('./insurance.tasks');
const { publishDueMilestones, publishExpired, milestoneFor } = require('./insurance.milestones');
const { startRenewalQuote } = require('./insurance.renewal');
const { resolveInsuranceWebhookSecret, credentialInVault } = require('./insurance.secrets');
const { installInsuranceEvents, applyInsuranceEvent } = require('./insurance.webhook');
const { readInsuranceParams, PADROES } = require('./insurance.params');
const { INSURANCE_SETTINGS_SCHEMA } = require('./insurance.settings');
const { installInsuranceReactions } = require('./insurance.react');

installInsuranceEvents();
installInsuranceReactions(); // M9-D220: o aviso ao responsável e a apólice vigente por evento interno do envio

module.exports = {
  callInsurer, proposalKey, ensureInsuranceConnection, PROVIDER_CODES, providerKeyOf, addPolicyVersion, listPolicyVersions, currentVersion, completeTask, cancelTask, listTasks,
  publishDueMilestones, publishExpired, milestoneFor, startRenewalQuote, resolveInsuranceWebhookSecret, credentialInVault, applyInsuranceEvent, readInsuranceParams, INSURANCE_PADROES: PADROES, INSURANCE_SETTINGS_SCHEMA,
};
