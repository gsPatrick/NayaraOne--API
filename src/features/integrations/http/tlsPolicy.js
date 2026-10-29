'use strict';

const tls = require('node:tls');

/**
 * Transporte seguro (M9-D244 3.1): TLS mínimo 1.2 e verificação de certificado e de hostname SEMPRE ligadas. Desligar a
 * verificação é proibido (o guarda de arquitetura procura o desligamento no código, no Dockerfile, no .env de exemplo e no CI).
 */
const MIN_TLS_VERSION = 'TLSv1.2';
const RANK = Object.freeze({ 'TLSv1': 1, 'TLSv1.1': 2, 'TLSv1.2': 3, 'TLSv1.3': 4 });

/** Opções TLS de toda chamada a fornecedor; `extra` (cert, key, ca) entra, mas nunca desfaz o mínimo nem a verificação. */
const secureTlsOptions = (extra = {}) => ({ ...extra, minVersion: MIN_TLS_VERSION, rejectUnauthorized: true });

/** O `fetch` global não aceita opções por chamada: sobe o mínimo do processo se alguém o baixou (flag do Node). Devolve o mínimo vigente. */
function ensureMinTlsVersion() {
  if ((RANK[tls.DEFAULT_MIN_VERSION] || 0) < RANK[MIN_TLS_VERSION]) tls.DEFAULT_MIN_VERSION = MIN_TLS_VERSION;
  return tls.DEFAULT_MIN_VERSION;
}

module.exports = { MIN_TLS_VERSION, secureTlsOptions, ensureMinTlsVersion };
