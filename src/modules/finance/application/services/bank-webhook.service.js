'use strict';

const crypto = require('node:crypto');
const AppError = require('../../../../utils/AppError');
const { getSetting } = require('../../../../features/settings/settings.service');
const { receiveEvent } = require('../../../../features/integrations/inbox');
const { PAYMENT_AGGREGATE, MISMATCH_CODE, MISMATCH_MESSAGE, providerCodeOf } = require('../../infrastructure/bank/hub/bank.constants');
const { resolveBankWebhookSecret } = require('../../infrastructure/bank/hub/bank.secrets');
const { dispatchOf } = require('../../infrastructure/bank/hub/bank.dispatch');

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 38, 2026-10-05): HMAC-SHA256 por tenant, timing-safe, fail-closed quando há provider real configurado.
const BANK_WEBHOOK_HEADER = 'x-webhook-signature';

function verifyBankWebhookSignature(rawBody, headers, webhookSecret) {
  if (!webhookSecret || !rawBody || rawBody.length === 0) return false;
  const received = headers ? headers[BANK_WEBHOOK_HEADER] : null;
  if (!received || typeof received !== 'string') return false;
  const receivedHex = received.startsWith('sha256=') ? received.slice('sha256='.length) : received;
  const expectedHex = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  let expectedBuffer;
  let receivedBuffer;
  try {
    expectedBuffer = Buffer.from(expectedHex, 'hex');
    receivedBuffer = Buffer.from(receivedHex, 'hex');
  } catch (err) {
    return false;
  }
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Identificador do evento para a caixa de entrada: o que o banco manda ou, sem ele, o hash do corpo assinado (o mesmo corpo é sempre o mesmo evento). */
const eventIdOf = (body, rawBody) => (typeof body.externalEventId === 'string' && body.externalEventId ? body.externalEventId : `sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`);

/**
 * processBankPaymentWebhook — corpo do webhook bancário público, recebendo a transação de fora (o controller abre a dele; o teste E2E do Financeiro usa a transação com
 * rollback). Resolve o tenant pela tabela de roteamento, aplica SET LOCAL, confere a assinatura HMAC (sempre, também em sandbox; o segredo vem do cofre, M9-D237) e só então
 * registra o evento na caixa de entrada (UNIQUE por fornecedor e id do evento: o duplicado nunca reaplica o efeito) e confirma o pagamento. Valor diferente do aprovado
 * não confirma: devolve { processed:false, mismatch:true, code } e o erro CRITICAL fica gravado para revisão humana.
 */
async function processBankPaymentWebhook({ body, rawBody, headers }, t, deps) {
  const { externalSubmissionId, status } = body || {};
  const { sequelize, BankPaymentProviderRouting } = require('../../../../models');
  const bankPaymentsService = deps && deps.bankPaymentsService ? deps.bankPaymentsService : require('./payment.service');
  // Resolve o tenant via routing table (sem RLS) ANTES de abrir qualquer SET LOCAL — mesma ordem de operações do webhook de assinatura.
  const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId }, transaction: t });
  if (!routing) {
    // 200 pra o provedor não reenviar infinitamente, mas o motivo fica EXPLÍCITO no campo `reason` — nunca um "received: true" indistinguível de sucesso real.
    return { received: true, processed: false, reason: 'unknown_routing' };
  }
  await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: routing.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: routing.companyId }, transaction: t });

  const tenant = { groupId: routing.groupId, companyId: routing.companyId };
  // B5 (revisão independente): assinatura HMAC exigida SEMPRE (o sandbox usa o próprio segredo configurado); sem segredo, falha fechado.
  const providerName = await getSetting('finance.payment_provider', tenant, t, 'sandbox');
  const { secret } = await resolveBankWebhookSecret({ tenant, transaction: t });
  if (!verifyBankWebhookSignature(rawBody, headers, secret)) {
    throw AppError.unauthorized('Assinatura HMAC do webhook bancário ausente ou inválida.', 'BANK_PAYMENT_WEBHOOK_HMAC_INVALID');
  }
  const envio = await dispatchOf(tenant, routing.paymentIntentId, t);
  const recebido = await receiveEvent(tenant, {
    providerCode: envio ? envio.providerCode : providerCodeOf(providerName) || 'bank-sandbox', externalEventId: eventIdOf(body, rawBody), rawBody, body, headers, eventType: 'bank.payment.status',
    connectionId: envio ? envio.connectionId : null, extraHeaders: { paymentIntentId: routing.paymentIntentId }, processedInline: true,
  }, t);
  if (recebido.status === 'duplicate') return { received: true, processed: false, reason: 'duplicate_event' };

  const intent = await bankPaymentsService.confirmBankPayment(externalSubmissionId, status, t, { sandbox: providerName === 'sandbox', amount: body.amount, source: 'WEBHOOK_SIGNED' });
  if (intent.bankMismatch) return { received: true, processed: false, mismatch: true, code: MISMATCH_CODE, message: MISMATCH_MESSAGE };
  return { received: true, processed: true };
}

module.exports = { processBankPaymentWebhook, verifyBankWebhookSignature, BANK_WEBHOOK_HEADER, PAYMENT_AGGREGATE };
