'use strict';

const util = require('node:util');

const REDACTED = '[REDACTED]';
const guardado = new WeakMap();

/**
 * Embrulho de um valor secreto (M9-D202 regra 2). O texto só sai por `reveal()`, no ponto exato de uso
 * (montar o cabeçalho de uma chamada, conferir uma assinatura). Qualquer serialização, interpolação ou
 * inspeção devolve "[REDACTED]", então log, erro, auditoria e resposta HTTP nunca carregam o valor.
 */
class SecretValue {
  constructor(valor) {
    guardado.set(this, String(valor));
  }

  reveal() {
    return guardado.get(this);
  }

  toJSON() { return REDACTED; }

  toString() { return REDACTED; }

  [util.inspect.custom]() { return REDACTED; }
}

module.exports = { SecretValue, REDACTED };
