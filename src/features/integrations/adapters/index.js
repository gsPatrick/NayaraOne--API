'use strict';

/**
 * Adapters que já existiam, adaptados ao contrato IntegrationAdapter (M9-D209) e registrados no boot. Adapter novo de uma
 * família entra aqui (ou em sua própria demanda) e passa pela mesma validação de contrato.
 */
const registry = require('../registry/adapterRegistry');
const { FinancingSandboxContractAdapter, FinancingManualContractAdapter } = require('./legacy/financing.adapters');
const { BankSandboxContractAdapter } = require('./legacy/bank.adapters');
const { BankSantanderContractAdapter } = require('./legacy/bank.santander');
const { SignatureClicksignContractAdapter, SignatureZapSignContractAdapter } = require('./legacy/signature.adapters');
const { SignatureSandboxAdapter } = require('../providers/signature/sandbox/signature-sandbox.adapter');
const { SignatureAltSandboxAdapter } = require('../providers/signature/sandbox/signature-alt-sandbox.adapter');
const { INSURANCE_ADAPTERS } = require('./legacy/insurance.registry');
const { FiscalSandboxContractAdapter } = require('./legacy/fiscal.adapters');
const { registerAiAdapters } = require('../../ai/providers/builtIn');
const { MessagingSandboxAdapter } = require('../providers/messaging/sandbox/messaging-sandbox.adapter');
const { PortalSandboxAdapter } = require('../providers/portal/sandbox/portal-sandbox.adapter');
const { PortalZapSandboxAdapter } = require('../providers/portal/sandbox/portal-zap-sandbox.adapter');
const { PortalVivaRealSandboxAdapter } = require('../providers/portal/sandbox/portal-vivareal-sandbox.adapter');
const { PortalOlxSandboxAdapter } = require('../providers/portal/sandbox/portal-olx-sandbox.adapter');
const { MessagingAltSandboxAdapter } = require('../providers/messaging/sandbox/messaging-alt-sandbox.adapter');
const { AnalyticsSandboxAdapter } = require('../providers/analytics/sandbox/analytics-sandbox.adapter');
const { SocialSandboxAdapter } = require('../providers/social/sandbox/social-sandbox.adapter');
const { EmailSandboxAdapter } = require('../providers/email/sandbox/email-sandbox.adapter');
const { StorageLocalDiskAdapter } = require('../providers/storage/storage-local-disk.adapter');
const { StorageSandboxAdapter } = require('../providers/storage/storage-sandbox.adapter');
const { StorageS3Adapter } = require('../providers/storage/storage-s3.adapter');
const { IdentityLocalAdapter } = require('../providers/identity/identity-local.adapter');
const { IdentitySandboxAdapter } = require('../providers/identity/sandbox/identity-sandbox.adapter');
const { SiteSandboxAdapter } = require('../providers/site/sandbox/site-sandbox.adapter');
const { installAnalytics } = require('../analytics');
const { registerAiContingency } = require('../providers/ai/ai.degrade');
const { installContingency } = require('../contingency');

const BUILT_IN_ADAPTERS = Object.freeze([
  FinancingSandboxContractAdapter, FinancingManualContractAdapter, BankSandboxContractAdapter, BankSantanderContractAdapter, SignatureSandboxAdapter,
  SignatureClicksignContractAdapter, SignatureZapSignContractAdapter, SignatureAltSandboxAdapter, ...INSURANCE_ADAPTERS, FiscalSandboxContractAdapter,
  MessagingSandboxAdapter, MessagingAltSandboxAdapter, PortalSandboxAdapter, PortalZapSandboxAdapter, PortalVivaRealSandboxAdapter, PortalOlxSandboxAdapter, AnalyticsSandboxAdapter, SocialSandboxAdapter, EmailSandboxAdapter,
  StorageLocalDiskAdapter, StorageSandboxAdapter, StorageS3Adapter, IdentityLocalAdapter, IdentitySandboxAdapter, // M9-D242
  SiteSandboxAdapter, // M9-D259
]);

/** Registra todos; contrato inválido lança 500 INTEGRATION_ADAPTER_CONTRACT_INVALID (o boot não segue). Devolve a lista registrada. */
function registerBuiltInAdapters() {
  BUILT_IN_ADAPTERS.forEach((A) => registry.register(A));
  registerAiAdapters(); // sandbox e fornecedores de modelo (M9-D011), pelo ProviderRegistry
  installAnalytics(); // descarte de métricas vencidas na rodada do worker (M9-D243)
  registerAiContingency(); // IA fora: modo determinístico (M9-D243)
  require('../email'); // M9-D234: identificador da mensagem no envio, falha definitiva e eventos do provedor (entregue, bounce, reclamação)
  require('../site'); // M9-D259: páginas do site (reações ao envio confirmado ou falho, webhook do site, consulta de status na rodada do worker e dados da reconciliação)
  require('../social'); // M9-D239: verificação do worker (conteúdo ainda aprovado, kill switch) e dados da reconciliação do post
  installContingency(); // contingência das famílias e passo da rodada do worker (M9-D226)
  return registry.list();
}

  require('../swap').installSwapDrain(); // drenagem da connection antiga numa troca de fornecedor (M9-D221)
module.exports = { registerBuiltInAdapters, BUILT_IN_ADAPTERS };
