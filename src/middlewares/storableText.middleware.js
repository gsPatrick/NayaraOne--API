'use strict';

const AppError = require('../utils/AppError');
const { findUnstorableText } = require('../utils/storableText');

const PARTES = Object.freeze({ body: 'corpo', query: 'consulta' });

/** Nome de campo para a mensagem: o próprio nome pode ser o texto ruim (`{"a\u0000": 1}`); o caractere sai trocado por U+FFFD e o nome é cortado em 64. */
const nomeVisivel = (campo) => {
  const limpo = campo.toWellFormed().split('\u0000').join('\uFFFD');
  return limpo.length > 64 ? `${limpo.slice(0, 64)}…` : limpo;
};

/**
 * Texto que o banco não grava (caractere nulo ou metade solta de um par sub-rogado; ver src/utils/storableText.js) é recusado na porta da API, para TODAS as
 * rotas (verificação independente do Marco 9, rodada 6, 12/11/2026; DI-M9R-15). Antes, `POST /messages/send` com `text`, `caption` ou `templateVars` assim dava
 * 500 (o jsonb do envio recusava), e outras rotas gravavam o texto alterado. Confere o corpo já lido (JSON ou formulário) e a consulta, depois dos leitores do
 * corpo e antes das rotas; o corpo bruto dos webhooks (Buffer) tem regra própria (webhooks/intake/intake.structure.js).
 * Resposta: 400 `INVALID_TEXT_CHARACTER`, com o nome do campo (nunca o valor) na mensagem e em `details.fields`.
 */
function rejectUnstorableText(req, _res, next) {
  for (const parte of ['query', 'body']) {
    const achado = findUnstorableText(req[parte]);
    if (achado === null) continue;
    const campo = achado === '' ? '' : nomeVisivel(achado);
    const onde = campo === '' ? `O ${PARTES[parte]} do pedido` : `O campo "${campo}" ${parte === 'query' ? 'da consulta ' : ''}`;
    return next(AppError.badRequest(
      `${onde.trimEnd()} tem um caractere que não pode ser gravado (caractere nulo ou metade solta de um caractere Unicode). Remova o caractere e envie de novo.`,
      'INVALID_TEXT_CHARACTER',
      { fields: [campo === '' ? PARTES[parte] : campo], part: parte }
    ));
  }
  return next();
}

module.exports = { rejectUnstorableText };
