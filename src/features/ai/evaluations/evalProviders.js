'use strict';

const { sandboxGenerate } = require('../providers/sandbox/sandboxGenerate');
const { SANDBOX_PROVIDER } = require('./evaluations.constants');

/**
 * Providers que a avaliação sabe chamar: `code -> generate({system, messages})`. Só o sandbox vem de fábrica; o ProviderRegistry
 * (M9-D011) registra os adapters reais aqui. A avaliação nunca chama fornecedor: chama a função registrada.
 */
const registry = new Map([[SANDBOX_PROVIDER, sandboxGenerate]]);

const registerEvalProvider = (code, generate) => { registry.set(code, generate); };
const hasEvalProvider = (code) => registry.has(code);
const resolveEvalProvider = (code) => registry.get(code);

module.exports = { registerEvalProvider, hasEvalProvider, resolveEvalProvider };
