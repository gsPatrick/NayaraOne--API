'use strict';

const AppError = require('../../../../utils/AppError');
const { isSandboxBlocked } = require('../../../../utils/sandboxPolicy');
const adapterRegistry = require('../../../integrations/registry/adapterRegistry');
const { ensureSandboxConnection, findActiveByDomain } = require('../../../integrations/registry/connections.ensureSandbox');

const SANDBOX = 'fiscal-sandbox';

const issuerNotConfigured = () => AppError.unprocessable(
  'O emissor de NFS-e ainda não está configurado para produção. Configure o emissor oficial antes de emitir notas.',
  'NFSE_ISSUER_NOT_CONFIGURED',
);

/** Só produção real (utils/sandboxPolicy.js): o emissor de laboratório (sandbox) não emite nota ali, que viraria um documento fiscal falso gravado como oficial. Em homologação ele fica disponível. */
const hardEnvironment = () => isSandboxBlocked();

/** Registra o adapter de laboratório quando o servidor não passou pelo boot (scripts e testes de serviço). */
function ensureFiscalAdapterRegistered() {
  if (adapterRegistry.has(SANDBOX)) return;
  adapterRegistry.register(require('../../../integrations/adapters/legacy/fiscal.adapters').FiscalSandboxContractAdapter);
}

/**
 * A connection de NFS-e da empresa (M9-D241): a primeira ATIVA da família FISCAL. Sem nenhuma, fora de produção a empresa ganha a do sandbox sozinha; em produção, ou com o
 * sandbox como única opção, a emissão é recusada como sempre foi (422 NFSE_ISSUER_NOT_CONFIGURED).
 */
async function ensureFiscalConnection(ctx, transaction) {
  ensureFiscalAdapterRegistered();
  const ativa = await findActiveByDomain(ctx, 'FISCAL', transaction);
  if (ativa) {
    if (hardEnvironment() && ativa.providerCode === SANDBOX) throw issuerNotConfigured();
    return ativa;
  }
  if (hardEnvironment()) throw issuerNotConfigured();
  return ensureSandboxConnection(ctx, { providerCode: SANDBOX, label: 'NFS-e: sandbox' }, transaction);
}

/** Versão do adapter gravada na nota ("adapter versionado" do Caderno do Marco 8): a do sandbox é a de sempre; a de um emissor real é a do contrato. */
const adapterVersionOf = (connection) => (connection.providerCode === SANDBOX ? 'sandbox-v1' : 'v1');

module.exports = { ensureFiscalConnection, ensureFiscalAdapterRegistered, adapterVersionOf, issuerNotConfigured, SANDBOX };
