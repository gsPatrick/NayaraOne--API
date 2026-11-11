'use strict';

/**
 * Porta do adapter de assinatura (Guia do Marco 5, §7):
 *
 *   interface SignatureAdapter {
 *     createEnvelope(req): Promise<{ externalId }>;
 *     cancelEnvelope(externalId): Promise<void>;
 *     getStatus(externalId): Promise<SignatureEnvelopeStatus>;
 *     verifyWebhook(headers, rawBody): boolean;
 *   }
 *
 * Os provedores (./providers: sandbox, Clicksign, ZapSign) implementam requestSignature/cancel/
 * getStatus; `toSignatureAdapter` os expõe com os nomes da porta, e a verificação do webhook
 * (HMAC-SHA256 do corpo bruto, comparação timing-safe) vive aqui, uma só para todos.
 */
const crypto = require('crypto');

const WEBHOOK_HEADER_BY_PROVIDER = {
  // Confirmado contra a documentação oficial do Clicksign (developers.clicksign.com,
  // 18/09/2026): header "Content-Hmac", valor "sha256=<hex>". ZapSign permanece assumido
  // (mesmo esquema hipotético) até haver credencial real para confirmar.
  clicksign: 'content-hmac',
  zapsign: 'x-zapsign-signature',
};

// CONFIRMADO contra webhooks reais do Clicksign (22/09/2026, via log de diagnóstico comparando
// candidatos de fórmula): é HMAC-SHA256 de verdade (chave = secret), IGUAL ao ZapSign — a
// documentação oficial ("Hash SHA256 da soma do Body com o Secret") sugeria concatenação, mas
// contra payloads reais só o HMAC genérico bateu. Mantido como uma função só (ambos os
// provedores usam o mesmo esquema); o nome do header ainda diferencia cada um.
function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * verifyProviderWebhookSignature — compara a assinatura do corpo BRUTO da requisição com o
 * valor recebido no header do provedor, usando `crypto.timingSafeEqual` — NUNCA comparação
 * direta de string (`===`), que vazaria timing e permitiria um ataque de força bruta byte a
 * byte sobre a assinatura esperada. `timingSafeEqual` exige buffers do mesmo tamanho, então
 * checamos o tamanho primeiro (uma incompatibilidade de tamanho já é "inválido").
 */
function verifyProviderWebhookSignature(provider, rawBody, headers, webhookSecret) {
  const headerName = WEBHOOK_HEADER_BY_PROVIDER[provider];
  if (!headerName || !webhookSecret || !rawBody || rawBody.length === 0) return false;

  const received = headers ? headers[headerName] : null;
  if (!received || typeof received !== 'string') return false;
  const receivedHex = received.startsWith('sha256=') ? received.slice('sha256='.length) : received;

  const expectedHex = computeHmacSha256Hex(webhookSecret, rawBody);

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

const PORT_METHODS = ['createEnvelope', 'cancelEnvelope', 'getStatus', 'verifyWebhook'];

/** Expõe um provedor com os métodos da porta do Guia §7. `webhookSecret` vem do cofre da empresa. */
function toSignatureAdapter(provider, { code, webhookSecret = null } = {}) {
  if (!provider || typeof provider.requestSignature !== 'function' || typeof provider.cancel !== 'function' || typeof provider.getStatus !== 'function') {
    throw new Error('SIGNATURE_ADAPTER_PORT_NOT_IMPLEMENTED');
  }
  return {
    code,
    async createEnvelope({ contractVersion, signerPersonIds, transaction }) {
      const r = await provider.requestSignature(contractVersion, signerPersonIds, transaction);
      return { ...r, externalId: r && (r.externalId || r.providerEnvelopeId || r.externalSignatureId) };
    },
    cancelEnvelope: (externalId) => provider.cancel(externalId),
    getStatus: (externalId) => provider.getStatus(externalId),
    // Sandbox não tem HMAC: a verificação recusa; a rota do sandbox tem guarda própria (assertSandboxWebhookAllowed).
    verifyWebhook: (headers, rawBody) => verifyProviderWebhookSignature(code, rawBody, headers, webhookSecret),
  };
}

module.exports = { PORT_METHODS, toSignatureAdapter, verifyProviderWebhookSignature, computeHmacSha256Hex };
