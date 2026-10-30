'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões do livro e do parametros.csv (M9-D235): referência `[PROC-n]`, até 20 anexos, verificação na hora, corpo até 20 mil caracteres. */
const PADROES = Object.freeze({ maxAttachments: 20, referencePrefixes: Object.freeze(['PROC']), verifyImmediately: true, bodyMaxChars: 20000, pollIntervalMin: 5 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Prefixos em maiúsculas, só letras e números, sem repetição; lista vazia ou inválida volta ao padrão. */
function parsePrefixes(texto) {
  if (typeof texto !== 'string') return PADROES.referencePrefixes;
  const lista = [...new Set(texto.split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,12}$/.test(x)))];
  return lista.length ? lista : PADROES.referencePrefixes;
}

async function readInboundParams(ctx, transaction) {
  const [anexos, prefixos, imediato, corpo, intervalo] = await Promise.all([
    getSetting('integration.email.inbound_max_attachments', ctx, transaction, PADROES.maxAttachments),
    getSetting('integration.email.inbound_reference_prefixes', ctx, transaction, PADROES.referencePrefixes.join(',')),
    getSetting('integration.email.inbound_verify_immediately', ctx, transaction, PADROES.verifyImmediately),
    getSetting('integration.email.inbound_body_max_chars', ctx, transaction, PADROES.bodyMaxChars),
    getSetting('integration.email.inbound_poll_interval_min', ctx, transaction, PADROES.pollIntervalMin),
  ]);
  return {
    maxAttachments: inteiro(anexos, PADROES.maxAttachments, 1),
    referencePrefixes: parsePrefixes(prefixos),
    verifyImmediately: typeof imediato === 'boolean' ? imediato : PADROES.verifyImmediately,
    bodyMaxChars: inteiro(corpo, PADROES.bodyMaxChars, 100),
    pollIntervalMin: inteiro(intervalo, PADROES.pollIntervalMin, 1),
  };
}

module.exports = { PADROES, readInboundParams, parsePrefixes };
