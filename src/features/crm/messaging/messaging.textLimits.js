'use strict';

const AppError = require('../../../utils/AppError');
const { readMessagingParams } = require('./messaging.params');

/**
 * Tamanho do texto livre das rotas de mensagem (verificação independente do Marco 9, rodada 6, 12/11/2026; DI-M9R-16). A DI-M9R-11 deixava `text`,
 * `caption`, as variáveis do modelo e o `body` do registro manual sem limite; um `text` de 256 KB sem espaço prendia a API por 2,5 minutos na redação
 * (corrigida para tempo linear em shared/redaction/patterns.js). O livro não fixa limite: vale o do canal, como parâmetro da empresa que o administrador
 * só pode apertar (whatsapp.params.js e messaging.params.js). Conferido ANTES de gravar, enfileirar ou redigir o texto. Acima: 400 `MESSAGE_VALIDATION`
 * com o nome do campo (nunca o valor).
 *
 * Caractere = ponto de código Unicode (o emoji conta 1, como o canal conta). A contagem para no primeiro caractere além do limite: um texto de 20 MB
 * custa o mesmo que um de 4.096 caracteres.
 */
function passaDe(texto, max) {
  if (typeof texto !== 'string' || texto.length <= max) return false; // pontos de código <= unidades UTF-16
  let n = 0;
  for (const _caractere of texto) { // eslint-disable-line no-unused-vars
    n += 1;
    if (n > max) return true;
  }
  return false;
}

const longoDemais = (campo, max) => AppError.badRequest(`O campo "${campo}" aceita no máximo ${max} caracteres.`, 'MESSAGE_VALIDATION', { fields: [campo], maxChars: max });

/** POST /messages/send e todo chamador do serviço de envio: `text`, `caption` e cada item de `templateVars` pelos limites do canal (`wa`). */
function assertSendTextLimits(input, wa) {
  if (passaDe(input.text, wa.maxTextChars)) throw longoDemais('text', wa.maxTextChars);
  if (passaDe(input.caption, wa.maxCaptionChars)) throw longoDemais('caption', wa.maxCaptionChars);
  if (Array.isArray(input.templateVars) && input.templateVars.some((v) => passaDe(v, wa.maxTemplateVarChars))) throw longoDemais('templateVars', wa.maxTemplateVarChars);
}

/** POST /messages (registro manual de interação): `body` por `integration.messaging.record_body_max_chars`. */
async function assertRecordBodyLimit(tenant, body, transaction) {
  if (typeof body !== 'string') return;
  const { recordBodyMaxChars } = await readMessagingParams(tenant, transaction);
  if (passaDe(body, recordBodyMaxChars)) throw longoDemais('body', recordBodyMaxChars);
}

module.exports = { assertSendTextLimits, assertRecordBodyLimit, passaDe };
