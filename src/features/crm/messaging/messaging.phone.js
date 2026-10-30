'use strict';

const AppError = require('../../../utils/AppError');

/** Telefone inválido (M9-D229 3.2 item 4): 422 antes de qualquer envio. */
const phoneInvalid = () => AppError.unprocessable('Número de telefone inválido: use o formato +55 DDD número.', 'INTEGRATION_MESSAGING_PHONE_INVALID');

/**
 * Valida o destinatário no formato E.164 do Brasil (`+55DDNNNNNNNNN`): sinal de +, código do país (parâmetro integration.messaging.country_code), DDD de dois dígitos (sem zero
 * à esquerda) e 8 ou 9 dígitos do número. Sem o código do país (ex.: 11999990000) é recusado: o sistema não adivinha. Devolve o número limpo.
 */
function assertE164(to, countryCode = '55') {
  const texto = typeof to === 'string' ? to.trim() : '';
  if (!new RegExp(`^\\+${countryCode}[1-9]\\d\\d{8,9}$`).test(texto)) throw phoneInvalid();
  return texto;
}

/** Só os dígitos do telefone. */
const digitsOf = (valor) => String(valor || '').replace(/\D/g, '');

/** Variações com que um número costuma estar gravado no cadastro de contatos: completo, sem o código do país e sem o 9 inicial do celular. */
function phoneVariants(e164, countryCode = '55') {
  const completo = digitsOf(e164);
  const nacional = completo.startsWith(countryCode) ? completo.slice(countryCode.length) : completo;
  const variantes = new Set([completo, nacional]);
  if (nacional.length === 11 && nacional[2] === '9') variantes.add(nacional.slice(0, 2) + nacional.slice(3));
  return [...variantes];
}

module.exports = { assertE164, phoneInvalid, digitsOf, phoneVariants };
