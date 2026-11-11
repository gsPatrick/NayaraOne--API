'use strict';

// Apoio dos testes do pagamento bancário sobre o registro de integração (M9-D237): intenção aprovada, webhook assinado, leitura dos envios e dos erros.
const crypto = require('node:crypto');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, createTestCostCenter, uniqueSuffix } = require('../../testHelpers');
const { createFinancialEntry } = require('../../../src/modules/finance/application/services/financial-entry.service');
const { createPaymentIntent, approvePaymentIntent } = require('../../../src/modules/finance/application/services/payment.service');
const bankPayments = require('../../../src/modules/finance/application/services/bank-submission.service');
const paymentService = require('../../../src/modules/finance/application/services/payment.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const { BankAccount, User, Person } = require('../../../src/models');

let tenant;
const carregar = async () => { tenant = await getSeedTenant(); try { registerBuiltInAdapters(); } catch { /* já registrados */ } return tenant; };
const ctxDe = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

/** Intenção APPROVED de `amount` (centavos exatos) para uma conta bancária com chave PIX. */
async function intencaoAprovada(t, { amount = 150.75, payeeName } = {}) {
  const costCenter = await createTestCostCenter(tenant, t);
  const dono = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: payeeName || `Favorecido D237 ${uniqueSuffix()}`, taxIdNormalized: String(Math.floor(Math.random() * 1e11)).padStart(11, '0'), createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const conta = await BankAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `D237-${uniqueSuffix()}`, pixKey: `pix-${uniqueSuffix()}@nayaraone.dev`, ownerPersonId: dono.id, status: 'ACTIVE' }, { transaction: t });
  const entry = await createFinancialEntry({
    groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `Pagamento D237 ${uniqueSuffix()}`, dueAt: new Date(Date.now() + 86400000), costCenterId: costCenter.id, bankAccountId: conta.id,
  }, tenant.userId, t);
  const intent = await createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
  const [aprovador] = await User.findOrCreate({ where: { email: `d237-aprovador-${uniqueSuffix()}@nayaraone.dev` }, defaults: { name: 'QA-M9 aprovador D237', passwordHash: 'x', status: 'ACTIVE' }, transaction: t });
  return { entry, conta, dono, intent: await approvePaymentIntent(intent.id, aprovador.id, t) };
}

/** Intenção enviada ao banco (sandbox) na transação `t`. */
async function intencaoEnviada(t, opts) {
  const base = await intencaoAprovada(t, opts);
  const intent = await bankPayments.submitPaymentIntentToBank(base.intent.id, 'PIX', { userId: tenant.userId }, t);
  return { ...base, intent };
}

const linhas = async (t, sql, replacements) => (await sequelize.query(sql, { replacements, transaction: t }))[0];
const envios = (t, intentId) => linhas(t, "SELECT * FROM integration.dispatches WHERE aggregate_type = 'PaymentIntent' AND aggregate_id = :id ORDER BY created_at", { id: intentId });
const erros = (t, code) => linhas(t, 'SELECT * FROM integration.integration_errors WHERE company_id = :c AND error_code = :code ORDER BY created_at DESC', { c: tenant.companyId, code });

const definirSegredoWebhook = (t, valor) => settingsService.upsertSetting('finance.bank_payment_webhook_secret', valor, tenant, tenant.userId, t);
const assinado = (segredo, corpo) => {
  const rawBody = Buffer.from(JSON.stringify(corpo));
  return { rawBody, headers: { 'x-webhook-signature': `sha256=${crypto.createHmac('sha256', segredo).update(rawBody).digest('hex')}` }, body: corpo };
};

module.exports = {
  sequelize, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix, carregar, ctxDe, intencaoAprovada, intencaoEnviada, envios, erros, definirSegredoWebhook, assinado, bankPayments, paymentService, linhas,
  get tenant() { return tenant; },
};
