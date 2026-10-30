'use strict';

/** Integridade do domínio diante de falha externa (Marco 9, M9-D220). Fachada da API do módulo. */
const { registerDomainReaction } = require('./domain.reaction');
const { compensateDispatch, COMPENSATIONS } = require('./domain.compensate');
const { guardExternalData } = require('./domain.external');
const { readDomainParams } = require('./domain.params');
const { DOMAIN_SETTINGS_SCHEMA } = require('./domain.settings');

module.exports = { registerDomainReaction, compensateDispatch, COMPENSATIONS, guardExternalData, readDomainParams, DOMAIN_SETTINGS_SCHEMA };
