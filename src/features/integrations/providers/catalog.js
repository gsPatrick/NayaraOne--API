'use strict';

/**
 * Fachada do catálogo de integrações (Marco 9, M9-D201). Responsabilidades, uma por arquivo:
 * catalog.domains (14 famílias, capabilities, criticidade padrão), catalog.providers (linhas do seed),
 * catalog.legacy (adapters e códigos que já existiam), catalog.validate (regras do cadastro),
 * catalog.seed (seed idempotente), catalog.settings (criticidade configurável), catalog.service (listagem).
 */
const domains = require('./catalog.domains');
const providers = require('./catalog.providers');
const legacy = require('./catalog.legacy');
const { assertDomain, assertCapabilitiesForDomain } = require('./catalog.validate');

module.exports = { ...domains, ...providers, ...legacy, assertDomain, assertCapabilitiesForDomain };
