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
const { InsuranceSandboxContractAdapter } = require('./legacy/insurance.adapters');
const { FiscalSandboxContractAdapter } = require('./legacy/fiscal.adapters');
const { registerAiAdapters } = require('../../ai/providers/builtIn');
const { MessagingSandboxAdapter } = require('../providers/messaging/sandbox/messaging-sandbox.adapter');
const { PortalSandboxAdapter } = require('../providers/portal/sandbox/portal-sandbox.adapter');
const { MessagingAltSandboxAdapter } = require('../providers/messaging/sandbox/messaging-alt-sandbox.adapter');
const { AnalyticsSandboxAdapter } = require('../providers/analytics/sandbox/analytics-sandbox.adapter');
const { SocialSandboxAdapter } = require('../providers/social/sandbox/social-sandbox.adapter');
const { EmailSandboxAdapter } = require('../providers/email/sandbox/email-sandbox.adapter');
const { installAnalytics } = require('../analytics');
const { registerAiContingency } = require('../providers/ai/ai.degrade');
const { installContingency } = require('../contingency');

const BUILT_IN_ADAPTERS = Object.freeze([
  FinancingSandboxContractAdapter, FinancingManualContractAdapter, BankSandboxContractAdapter, BankSantanderContractAdapter, SignatureSandboxAdapter,
  SignatureClicksignContractAdapter, SignatureZapSignContractAdapter, SignatureAltSandboxAdapter, InsuranceSandboxContractAdapter, FiscalSandboxContractAdapter,
  MessagingSandboxAdapter, MessagingAltSandboxAdapter, PortalSandboxAdapter, AnalyticsSandboxAdapter, SocialSandboxAdapter, EmailSandboxAdapter,
]);

/** Registra todos; contrato inválido lança 500 INTEGRATION_ADAPTER_CONTRACT_INVALID (o boot não segue). Devolve a lista registrada. */
function registerBuiltInAdapters() {
  BUILT_IN_ADAPTERS.forEach((A) => registry.register(A));
  registerAiAdapters(); // sandbox e fornecedores de modelo (M9-D011), pelo ProviderRegistry
  installAnalytics(); // descarte de métricas vencidas na rodada do worker (M9-D243)
  registerAiContingency(); // IA fora: modo determinístico (M9-D243)
  require('../email'); // M9-D234: identificador da mensagem no envio, falha definitiva e eventos do provedor (entregue, bounce, reclamação)
  require('../social'); // M9-D239: verificação do worker (conteúdo ainda aprovado, kill switch) e dados da reconciliação do post
  installContingency(); // contingência das famílias e passo da rodada do worker (M9-D226)
  return registry.list();
}

module.exports = { registerBuiltInAdapters, BUILT_IN_ADAPTERS };
