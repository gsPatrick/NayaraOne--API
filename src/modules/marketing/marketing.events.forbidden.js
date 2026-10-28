'use strict';

/**
 * M9-D434 — dado que NUNCA entra no payload de evento de Marketing: endereço de contato (e-mail, telefone, endereço postal), texto
 * integral de mensagem e segredo. Vale para nomes de campo (em qualquer profundidade) e para valores de texto.
 */
// Palavras longas valem como trecho do nome; palavras curtas só como termo inteiro (camelCase e _ separam termos), para que
// "accepted" não seja confundido com "cep".
const FORBIDDEN_KEY_PART = /(e-?mail|phone|telefone|celular|address|endereco|logradouro|password|senha|secret|segredo|credential|authorization|api_?key|message|mensagem|assunto)/i;
const FORBIDDEN_KEY_TERM = /(^|[^a-z])(body|corpo|text|texto|html|msg|fone|cep|zip|street|token|cpf|cnpj)($|[^a-z])/;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_VALUE = /^\+\d{10,15}$|^\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]\d{4}$/;
const SECRET_VALUE = /(bearer\s+\S{8,}|sk-[a-z0-9]{12,}|-----BEGIN [A-Z ]+-----|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/i;
const MAX_TEXT = 512;

function forbiddenKey(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return FORBIDDEN_KEY_PART.test(spaced) || FORBIDDEN_KEY_TERM.test(spaced);
}

/** Motivo da recusa de um valor de texto, ou null. */
function forbiddenValue(text) {
  if (typeof text !== 'string') return null;
  if (text.length > MAX_TEXT) return 'TEXT_TOO_LONG';
  if (EMAIL_VALUE.test(text)) return 'EMAIL';
  if (PHONE_VALUE.test(text.trim())) return 'PHONE';
  if (SECRET_VALUE.test(text)) return 'SECRET';
  return null;
}

/** Percorre o valor e devolve o caminho do primeiro dado proibido ({path, reason}) ou null. */
function findForbidden(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbidden(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (forbiddenKey(key)) return { path: here, reason: 'KEY' };
      const hit = findForbidden(inner, here);
      if (hit) return hit;
    }
    return null;
  }
  const reason = forbiddenValue(value);
  return reason ? { path, reason } : null;
}

module.exports = { findForbidden, forbiddenKey, forbiddenValue, MAX_TEXT };
