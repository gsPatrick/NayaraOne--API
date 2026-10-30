'use strict';

const adapterRegistry = require('../registry/adapterRegistry');
const { ensureSandboxConnection, findActiveByDomain } = require('../registry/connections.ensureSandbox');

const SANDBOX = 'email-sandbox';

/** Registra o adapter de laboratório quando o servidor não passou pelo boot (scripts e testes de serviço); o boot normal já o registrou. */
function ensureEmailAdapterRegistered() {
  if (adapterRegistry.has(SANDBOX)) return;
  adapterRegistry.register(require('../providers/email/sandbox/email-sandbox.adapter').EmailSandboxAdapter);
}

/**
 * A connection de e-mail da empresa (M9-D234): a primeira ATIVA da família EMAIL no ambiente do servidor; sem nenhuma, fora de produção a empresa ganha a do sandbox
 * sozinha. Em produção, sem integração ativa: 404 INTEGRATION_CONNECTION_NOT_FOUND.
 */
async function ensureEmailConnection(ctx, transaction) {
  ensureEmailAdapterRegistered();
  return (await findActiveByDomain(ctx, 'EMAIL', transaction)) || ensureSandboxConnection(ctx, { providerCode: SANDBOX, label: 'E-mail: sandbox' }, transaction);
}

module.exports = { ensureEmailConnection, ensureEmailAdapterRegistered, SANDBOX };
