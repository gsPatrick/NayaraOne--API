'use strict';

/**
 * Detecção e máscara de credenciais em texto para as guardas da NAY (M9-D005 trecho de fonte; M9-D008 conhecimento). Usa a
 * biblioteca única de redaction (src/shared/redaction, M9-D246): o perfil conservador decide se o texto "parece credencial", os
 * nomes de chave sensíveis pegam o valor estruturado (`{"token": "..."}`) e o perfil de log troca segredo e dado pessoal por máscara.
 * Não há lista de padrões própria da NAY.
 */
const { CONSERVATIVE_SECRET_PATTERNS, redactText, isSensitiveKey } = require('../../../shared/redaction');

/** Tamanho mínimo de um valor, sob chave sensível, para contar como credencial (evita barrar "token": "n/a"). */
const MIN_SECRET_VALUE_LENGTH = 8;

const hasPattern = (texto) => CONSERVATIVE_SECRET_PATTERNS.some((re) => re.test(texto));

function walk(valor) {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string') return hasPattern(valor);
  if (Array.isArray(valor)) return valor.some(walk);
  if (typeof valor === 'object') {
    return Object.entries(valor).some(([chave, v]) => {
      if (isSensitiveKey(chave) && typeof v === 'string' && v.trim().length >= MIN_SECRET_VALUE_LENGTH) return true;
      return walk(v);
    });
  }
  return false;
}

/** true se o texto, ou algum valor do JSON, parece conter uma credencial. */
function containsSecret(valor) {
  return walk(valor) || (typeof valor === 'object' && valor !== null && hasPattern(JSON.stringify(valor)));
}

/** Troca cada credencial (e dado pessoal reconhecível) por máscara, mantendo o resto do texto. */
function maskSecrets(texto) {
  return redactText(String(texto || ''));
}

module.exports = { containsSecret, maskSecrets };
