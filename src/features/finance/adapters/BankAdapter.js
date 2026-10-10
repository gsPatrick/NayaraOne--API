'use strict';

const https = require('https');
const { URL } = require('url');
const AppError = require('../../../utils/AppError');

// Node 24 (`fetch` global do undici) não aceita `agent`/certificado mTLS sem instalar o pacote
// `undici` separadamente. Em vez de somar uma dependência nova só pra isso, o provider
// Santander usa https.request nativo, que já suporta `agent: new https.Agent({cert, key})`
// nativamente — mesmo mecanismo, sem dependência extra.
function httpsRequestJson({ method, url, headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        method,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers,
        agent,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Interface comum (duck-typed, mesmo estilo de legal/adapters/SignatureAdapter.js):
//   async submitPayment(req) -> { externalId, status, raw }
//   async getPaymentStatus(externalId) -> { externalId, status, raw }
//   async fetchTransactions(cursor) -> { transactions: [...], nextCursor }
// "Cada banco/provider fica atrás desse contrato. Trocar fornecedor não altera PaymentService."
// (Guia Marcelo • Centro Financeiro, seção 6 "Adapter bancário")

class SandboxBankAdapter {
  async submitPayment(req) {
    const externalId = `sandbox-${req.idempotencyKey || Date.now()}`;
    return { externalId, status: 'PENDING_EXTERNAL', raw: { sandbox: true, req } };
  }

  async getPaymentStatus(externalId) {
    // Mock determinístico: toda consulta em sandbox confirma — suficiente pra testar o fluxo
    // completo (submit -> status -> confirm -> ledger) sem nenhuma rede real.
    return { externalId, status: 'CONFIRMED', raw: { sandbox: true } };
  }

  async fetchTransactions(cursor) {
    return { transactions: [], nextCursor: null };
  }
}

class SantanderBankAdapter {
  // CORRIGIDO após pesquisa real (developer.santander.com.br, verificado antes de implementar
  // — ver PROVIDER_BANCARIO.md seção 2.1): a API do Santander exige mTLS (certificado cliente
  // A1 emitido pelo banco) + OAuth2 client_credentials sobre essa conexão — não é token/secret
  // simples. Sandbox real existe em trust-sandbox.api.santander.com.br.
  constructor({ clientId, clientSecret, certPem, keyPem, workspaceId, baseUrl }) {
    if (!clientId || !clientSecret || !certPem || !keyPem || !workspaceId) {
      throw AppError.internal('Configuração do provider Santander incompleta.', 'FINANCE_BANK_PROVIDER_CONFIG_MISSING');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.workspaceId = workspaceId;
    this.baseUrl = baseUrl || 'https://trust-sandbox.api.santander.com.br';
    this._httpsAgent = new https.Agent({ cert: certPem, key: keyPem });
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - 5000) return this._accessToken;
    const bodyStr = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();
    const { statusCode, body } = await httpsRequestJson({
      method: 'POST',
      url: `${this.baseUrl}/auth/oauth/v2/token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr) },
      body: bodyStr,
      agent: this._httpsAgent,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw AppError.internal('Falha ao autenticar com o provider Santander.', 'FINANCE_BANK_PROVIDER_AUTH_ERROR', { status: statusCode, body });
    }
    this._accessToken = body.access_token;
    this._tokenExpiresAt = Date.now() + (Number(body.expires_in) || 300) * 1000;
    return this._accessToken;
  }

  async _request(method, path, payload) {
    const token = await this._getAccessToken();
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const { statusCode, body } = await httpsRequestJson({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Application-Key': this.clientId,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      body: bodyStr,
      agent: this._httpsAgent,
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw AppError.internal('Erro na chamada ao provider bancário Santander.', 'FINANCE_BANK_PROVIDER_ERROR', { status: statusCode, body });
    }
    return body;
  }

  // NOTA: escrito contra a documentação pública da API Santander (PIX/Cobrança v2), mas NUNCA
  // testado contra credencial real — a Nayara ainda não contratou/homologou o produto junto ao
  // banco (ver PROVIDER_BANCARIO.md seção 4). Mesmo status de ZapSignSignatureAdapter.
  async submitPayment(req) {
    const path = req.paymentMethod === 'PIX'
      ? `/pix/v1/workspaces/${this.workspaceId}/pix-payments`
      : `/collection_bill_management/v2/workspaces/${this.workspaceId}/bank_slips`;
    const raw = await this._request('POST', path, req.providerPayload);
    return { externalId: raw?.id || raw?.paymentId, status: 'PENDING_EXTERNAL', raw };
  }

  async getPaymentStatus(externalId) {
    const raw = await this._request('GET', `/collection_bill_management/v2/workspaces/${this.workspaceId}/bank_slips/${externalId}`);
    return { externalId, status: raw?.status, raw };
  }

  async fetchTransactions(cursor) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const raw = await this._request('GET', `/account_information/v1/workspaces/${this.workspaceId}/statements${query}`);
    return { transactions: raw?.transactions || [], nextCursor: raw?.nextCursor || null };
  }
}

module.exports = { SandboxBankAdapter, SantanderBankAdapter };
