'use strict';

const { sandboxGenerate } = require('../providers/sandbox/sandboxGenerate');
const { SANDBOX_PROVIDER } = require('./evaluations.constants');

/**
 * Providers que a avaliação sabe chamar: `code -> generate({system, messages}, { ctx, transaction })`, síncrona ou assíncrona. Só o
 * sandbox vem de fábrica; o ProviderRegistry (M9-D011) registra aqui, no `register`, cada adapter real (que só responde com conexão ativa). A avaliação nunca chama fornecedor: chama a função registrada.
 */
const registry = new Map([[SANDBOX_PROVIDER, sandboxGenerate]]);

const registerEvalProvider = (code, generate) => { registry.set(code, generate); };
const hasEvalProvider = (code) => registry.has(code);
const resolveEvalProvider = (code) => registry.get(code);

module.exports = { registerEvalProvider, hasEvalProvider, resolveEvalProvider };
