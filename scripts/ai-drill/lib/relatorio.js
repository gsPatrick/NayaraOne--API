'use strict';

/**
 * M9-D046 — relatório de um failure drill: uma lista de checagens (nome, ok, detalhe) e o veredito. Uma checagem que lança exceção
 * vira checagem vermelha com a mensagem; o drill nunca "passa" por não ter executado.
 */
class Relatorio {
  constructor() { this.checagens = []; }

  confere(nome, condicao, detalhe = null) {
    this.checagens.push({ nome, ok: Boolean(condicao), detalhe: detalhe === null || detalhe === undefined ? null : String(detalhe) });
    return Boolean(condicao);
  }

  get ok() { return this.checagens.length > 0 && this.checagens.every((c) => c.ok); }
}

module.exports = { Relatorio };
