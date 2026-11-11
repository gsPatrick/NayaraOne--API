'use strict';

/**
 * Provedores de assinatura (Guia do Marco 5, §2 signatures/providers/): uma implementação por
 * provedor, todas cumprindo a porta de ../signature-adapter.port.js.
 */
const { SandboxSignatureAdapter } = require('./sandbox.provider');
const { ClicksignSignatureAdapter } = require('./clicksign.provider');
const { ZapSignSignatureAdapter } = require('./zapsign.provider');

module.exports = { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter };
