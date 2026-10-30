'use strict';

const adapterRegistry = require('../registry/adapterRegistry');

/**
 * Garante os portais sandbox no AdapterRegistry (M9-D232). O servidor registra todos no boot (integrations/adapters/index.js); este atalho serve a quem publica sem o boot
 * do servidor (scripts e testes de serviço): registra só os de portal, com a mesma validação de contrato, e não faz nada se já estiverem registrados.
 */
function ensurePortalAdaptersRegistered() {
  const { PortalZapSandboxAdapter } = require('../providers/portal/sandbox/portal-zap-sandbox.adapter');
  const { PortalVivaRealSandboxAdapter } = require('../providers/portal/sandbox/portal-vivareal-sandbox.adapter');
  const { PortalOlxSandboxAdapter } = require('../providers/portal/sandbox/portal-olx-sandbox.adapter');
  const { PortalSandboxAdapter } = require('../providers/portal/sandbox/portal-sandbox.adapter');
  [PortalSandboxAdapter, PortalZapSandboxAdapter, PortalVivaRealSandboxAdapter, PortalOlxSandboxAdapter].forEach((A) => {
    if (!adapterRegistry.has(new A(null).providerCode())) adapterRegistry.register(A);
  });
}

module.exports = { ensurePortalAdaptersRegistered };
