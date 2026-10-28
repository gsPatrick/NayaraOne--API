'use strict';

const { sanitizeText } = require('../integrations/errors/sanitizeForError');

/**
 * sanitizeProviderMessage — mensagem de erro de provider/biblioteca segura para guardar em banco,
 * evento ou auditoria. Desde o Marco 9 (M9-D207) delega ao sanitizador único de erros de integração
 * (`sanitizeForError`): tira endereços, cabeçalhos de autorização, IPs, e-mail, CPF/CNPJ, telefone e
 * trechos longos que parecem token. Mantém o texto útil e limita o tamanho.
 */
function sanitizeProviderMessage(message, fallback = 'Falha na comunicação com o provider.') {
  const text = String(message || '').trim();
  if (!text) return fallback;
  return sanitizeText(text, 240);
}

module.exports = { sanitizeProviderMessage };
