'use strict';

/**
 * Parâmetros da assinatura digital do Jurídico (Marco 9, M9-D236): só o dicionário de SETTINGS_SCHEMA; a leitura está em signature.params.js.
 * A escolha do fornecedor continua em `legal.signature_provider` (sandbox, sandbox-alt, clicksign, zapsign).
 */
const SIGNATURE_SETTINGS_SCHEMA = Object.freeze({
  // M9-D236 3.2 item 4 (livro: "contrato só vai a SIGNED com todas as assinaturas obrigatórias com evidência completa"): desligar só para laboratório.
  'legal.assinatura.exigir_evidencia_completa': { type: 'boolean' },
  // M9-D236 3.2 item 4 (livro: IP e user-agent "quando fornecidos"): ligado, a evidência sem IP e user-agent do fornecedor não conta como completa.
  'legal.assinatura.exigir_ip_user_agent': { type: 'boolean' },
});

module.exports = { SIGNATURE_SETTINGS_SCHEMA };
