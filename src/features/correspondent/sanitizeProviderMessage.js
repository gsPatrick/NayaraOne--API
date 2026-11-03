'use strict';

/**
 * sanitizeProviderMessage — mensagem de erro de provider/biblioteca segura para guardar em banco,
 * evento ou auditoria. Mantém o texto útil, mas tira o que pode carregar segredo: endereços,
 * cabeçalhos de autorização, trechos longos que parecem token e IPs. Limita o tamanho.
 */
function sanitizeProviderMessage(message, fallback = 'Falha na comunicação com o provider.') {
  let text = String(message || '').trim();
  if (!text) return fallback;
  text = text
    .replace(/https?:\/\/\S+/gi, '[endereço removido]')
    .replace(/\b(bearer|basic|token|apikey|api-key|secret|password|senha)\b\s*[:=]?\s*\S+/gi, '$1 [removido]')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '[ip removido]')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[removido]');
  return text.slice(0, 240);
}

module.exports = { sanitizeProviderMessage };
