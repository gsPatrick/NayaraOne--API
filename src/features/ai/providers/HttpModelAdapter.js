'use strict';

const { AIProviderAdapter } = require('./AIProviderAdapter');
const { AiProviderError } = require('./providers.errors');
const { modelProblems } = require('./providers.models');
const { assertBaseUrlAllowed } = require('./baseUrl.policy');

/** Linha de config_json.models -> linha do catálogo (maxInput/maxOutput viram maxInputTokens/maxOutputTokens). */
function fromConfig(m) {
  if (!m || typeof m !== 'object') return m;
  const { maxInput, maxOutput, ...resto } = m;
  return { ...resto, maxInputTokens: maxInput, maxOutputTokens: maxOutput };
}

/**
 * Base dos adapters REAIS (M9-D011): fornecedor de modelo por HTTP, conta e preços por configuração. Tudo passa por
 * `ctx.http` (IntegrationHttpClient: tempo máximo, tentativas só para erro transitório e circuito por conexão); a credencial vem
 * de `ctx.secret` no instante da chamada. O catálogo de modelos (com preço, p95 e safetyTier) é da CONEXÃO
 * (`config_json.models`): preço de fornecedor muda, então não vive no código. Sem conexão (boot), `models()` é vazio.
 * Adapter real nasce desabilitado: só vale com conexão ACTIVE, que exige a referência do segredo.
 */
class HttpModelAdapter extends AIProviderAdapter {
  /** Subclasses: endereço padrão do fornecedor (pode ser trocado por `config_json.baseUrl`, ex. para um proxy ou o servidor de teste). */
  defaultBaseUrl() { throw new Error('defaultBaseUrl() não implementado'); }

  /** Subclasses: cabeçalhos de autenticação com a chave. */
  authHeaders(_key) { throw new Error('authHeaders() não implementado'); }

  /** Subclasses: caminho de uma leitura barata para o teste de saúde. */
  healthPath() { throw new Error('healthPath() não implementado'); }

  config() { return (this.ctx && this.ctx.connection && this.ctx.connection.config) || {}; }

  baseUrl() {
    const custom = this.config().baseUrl;
    if (custom) {
      assertBaseUrlAllowed({ baseUrl: String(custom), defaultBaseUrl: this.defaultBaseUrl(), egressHosts: (this.ctx && this.ctx.baseUrlHosts) || [], providerCode: this.providerCode() });
    }
    return String(custom || this.defaultBaseUrl()).replace(/\/+$/, '');
  }

  models() {
    const lista = Array.isArray(this.config().models) ? this.config().models : [];
    return lista.map(fromConfig).filter((m) => modelProblems(m).length === 0);
  }

  /** POST JSON; devolve { json, latencyMs, status }. Resposta de erro, rede e corpo ilegível viram AiProviderError. */
  async postJson(path, body, { key, timeoutMs, idempotencyKey } = {}) {
    const inicio = Date.now();
    let response;
    try {
      response = await this.ctx.http.request({
        method: 'POST',
        url: `${this.baseUrl()}${path}`,
        headers: { 'content-type': 'application/json', ...this.authHeaders(key), ...(idempotencyKey ? { 'idempotency-key': String(idempotencyKey) } : {}) },
        body: JSON.stringify(body),
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      });
    } catch (err) {
      throw this.failure(err);
    }
    if (!response.ok) throw this.failure({ status: response.status, headers: response.headers });
    let json;
    try { json = await response.json(); } catch (e) { throw new AiProviderError('UNKNOWN', { providerCode: this.providerCode(), upstreamCode: 'BAD_BODY' }); }
    return { json, latencyMs: Date.now() - inicio, status: response.status };
  }

  async healthCheck() {
    const inicio = Date.now();
    try {
      const key = await this.apiKey('test-connection');
      const response = await this.ctx.http.request({ method: 'GET', url: `${this.baseUrl()}${this.healthPath()}`, headers: this.authHeaders(key), maxAttempts: 1 });
      if (!response.ok) throw this.failure({ status: response.status, headers: response.headers });
      return { ok: true, latencyMs: Date.now() - inicio, detail: 'O provedor respondeu.' };
    } catch (err) {
      const e = err instanceof AiProviderError ? err : this.failure(err);
      return { ok: false, latencyMs: Date.now() - inicio, detail: e.message };
    }
  }
}

module.exports = { HttpModelAdapter };
