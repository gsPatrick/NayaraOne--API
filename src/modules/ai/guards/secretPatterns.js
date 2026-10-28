'use strict';

/**
 * Detecção e máscara de credenciais em texto para as guardas da NAY (M9-D005 trecho de fonte; M9-D008 conhecimento). Usa a
 * biblioteca única de redaction (src/shared/redaction, M9-D246): o perfil conservador decide se o texto "parece credencial" e o
 * perfil de log troca segredo e dado pessoal por máscara. Não há lista de padrões própria da NAY.
 */
const { CONSERVATIVE_SECRET_PATTERNS, redactText } = require('../../../shared/redaction');

function paraTexto(valor) {
  if (valor === null || valor === undefined) return '';
  return typeof valor === 'string' ? valor : JSON.stringify(valor);
}

/** true se o texto (ou o JSON, percorrido como texto) parece conter uma credencial. */
function containsSecret(valor) {
  const texto = paraTexto(valor);
  return CONSERVATIVE_SECRET_PATTERNS.some((re) => re.test(texto));
}

/** Troca cada credencial (e dado pessoal reconhecível) por máscara, mantendo o resto do texto. */
function maskSecrets(texto) {
  return redactText(String(texto || ''));
}

module.exports = { containsSecret, maskSecrets };
