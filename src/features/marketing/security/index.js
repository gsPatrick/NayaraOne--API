'use strict';

/**
 * Segurança e antifraude do Marketing (M9-D433, Caderno §14): validação da URL externa (8 critérios), conta social comprometida (revoga o token, marca a conexão e trava o
 * canal), recusa de exportação de destinatários e a mesma regra de URL para tracking links, templates e conteúdo. A mensagem em massa (permissão e tetos) fica em
 * marketing.guards.js (assertMassSendAllowed). Fachada: o resto do Marketing importa só daqui.
 */
const { validateExternalUrl } = require('./validateExternalUrl');
const { extractUrls, stripUrls, findDisallowedUrls, assertUrlsAllowed } = require('./urlText');
const { URL_SETTINGS_SCHEMA, URL_SETTING_DEFAULTS, readUrlConfig } = require('./url.settings');
const { handleCompromised } = require('./compromise.service');
const { isAuthRevoked, reportAuthRevoked } = require('./compromise.signal');
const { recipientExportGuard, looksLikeExport } = require('./exportGuard');
const { REASONS } = require('./urlRules');
const { registerChannelPorts } = require('./compromise.ports');
const { markPublicPayload, isPublicPayload, assertPublicPayload } = require('./publicPayload');

/** Validador do link rastreável (tracking.registerExternalUrlValidator): { ok, reasons } no contrato do D431. */
async function trackingUrlValidator(rawUrl, ctx) {
  const out = await validateExternalUrl(rawUrl, ctx || {});
  return { ok: out.ok, reasons: out.reasons };
}

module.exports = {
  validateExternalUrl, extractUrls, stripUrls, findDisallowedUrls, assertUrlsAllowed, trackingUrlValidator, URL_SETTINGS_SCHEMA, URL_SETTING_DEFAULTS, readUrlConfig, URL_REASONS: REASONS,
  handleCompromised, registerChannelPorts, markPublicPayload, isPublicPayload, assertPublicPayload, isAuthRevoked, reportAuthRevoked, recipientExportGuard, looksLikeExport,
};
