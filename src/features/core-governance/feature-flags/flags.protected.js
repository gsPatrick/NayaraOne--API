'use strict';

const E = require('./flags.errors');

/**
 * Chaves que têm dono (M9-D870, reabertura N1): o módulo dono registra quais chaves são dele e só ele as escreve pelo serviço, passando o próprio nome em `{ owner }`. A API
 * genérica (POST e PATCH /feature-flags, só com governance:flags:manage) nunca passa o dono, então não toca nessas chaves: o estado delas muda só pelo fluxo do dono, com os
 * controles dele (por exemplo, o canary da migração: gate, blockers, RACI e MFA). A recusa é 403 `GOV_FLAG_KEY_PROTECTED`, antes de gravar qualquer coisa.
 */
const registry = new Map();

/** `test(key)` diz se a chave (já em minúsculas) é do dono; `message` é a explicação em português devolvida a quem tentou. Registrar de novo o mesmo dono substitui. */
function registerProtectedKeys(owner, { test, message }) {
  if (!owner || typeof test !== 'function') throw new TypeError('registerProtectedKeys: informe o dono e a função de teste da chave.');
  registry.set(owner, { test, message });
}

/** Lança 403 se a chave pertence a um dono diferente de `owner`. */
function assertWritable(key, owner) {
  for (const [name, rule] of registry) {
    if (name !== owner && rule.test(String(key))) throw E.keyProtected(rule.message, { key: String(key) });
  }
}

module.exports = { registerProtectedKeys, assertWritable };
