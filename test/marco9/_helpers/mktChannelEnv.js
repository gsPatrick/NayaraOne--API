'use strict';

// Apoio dos testes M9-D430 (adapters de canal do Marketing): sandbox por canal, payload de exemplo e cofre/tenant. Não é teste.
const adapters = require('../../../src/features/marketing/publications/adapters');

const { CHANNEL_META, SandboxChannelAdapter } = adapters;

const operationOf = (channel) => CHANNEL_META[channel].operation;
/** Parâmetros pequenos para o teste não esperar: o SLOW e o Retry-After são parâmetros da empresa (aqui injetados). */
const sandboxFor = (channel, extra = {}) => new SandboxChannelAdapter(channel, { scope: 'qa-m9', slowMs: 5, retryAfterS: 7, ...extra });
const payload = (over = {}) => ({ to: '+5511999990000', texto: 'Olá, conheça o imóvel', ...over });

module.exports = { operationOf, sandboxFor, payload };
