'use strict';

const { sandboxGenerate } = require('../providers/sandbox/sandboxGenerate');
const { SANDBOX_PROVIDER } = require('./evaluations.constants');
const { SANDBOX_PROFILE_CODES, makeProfileGenerate } = require('../providers/sandbox/sandboxProfiles');

/**
 * Providers que a avaliação sabe chamar: `code -> generate({system, messages}, { ctx, transaction })`, síncrona ou assíncrona. Só o
 * sandbox e os seus dois perfis (sandbox-a e sandbox-b, M9-D033) vêm de fábrica; o ProviderRegistry (M9-D011) registra aqui, no `register`, cada adapter real (que só responde com conexão ativa). A avaliação nunca chama fornecedor: chama a função registrada.
 */
const registry = new Map([[SANDBOX_PROVIDER, sandboxGenerate], ...SANDBOX_PROFILE_CODES.map((code) => [code, makeProfileGenerate(code)])]);

const registerEvalProvider = (code, generate) => { registry.set(code, generate); };
const hasEvalProvider = (code) => registry.has(code);
const resolveEvalProvider = (code) => registry.get(code);

module.exports = { registerEvalProvider, hasEvalProvider, resolveEvalProvider };
