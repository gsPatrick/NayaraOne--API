'use strict';

const crypto = require('node:crypto');
const { AIProviderAdapter } = require('../AIProviderAdapter');
const { AiProviderError } = require('../providers.errors');
const { microsToAmount } = require('../providers.cost');
const { sandboxGenerate } = require('./sandboxGenerate');
const { sandboxEmbedText } = require('./sandboxEmbed');
const { failureFixture } = require('./sandboxFailure');
const { SANDBOX_CODE, SANDBOX_DIMENSIONS, SANDBOX_MODELS } = require('./sandboxModels');

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const tokensOf = (t) => Math.ceil(String(t).length / 4);
const lastUser = (messages) => { const m = [...(messages || [])].reverse().find((x) => x && x.role === 'user'); return m ? String(m.content || '') : ''; };

/**
 * Adapter `ai-sandbox` (M9-D011): determinístico, NUNCA faz rede, usado por todos os testes e pelo laboratório. A resposta é
 * função pura de system + mensagens; as fixtures do último `user` (`[[ECO]]`, `[[JSON]]`, `[[TOOL]]`, `[[FALHA:x]]`, `[[LENTO:ms]]`,
 * `[[CUSTO:valor]]`) ficam em sandboxGenerate e sandboxFailure. Declara as quatro capacidades para os testes de capacidade.
 */
class SandboxAdapter extends AIProviderAdapter {
  providerCode() { return SANDBOX_CODE; }

  capabilities() { return ['generate', 'embed', 'transcribe', 'analyzeImage']; }

  models() { return SANDBOX_MODELS.map((m) => ({ ...m })); }

  static get requiresConnection() { return false; }

  static get labOnly() { return true; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Provedor de testes: sem rede.' }; }

  /** Simula a latência do modelo contra o tempo máximo do pedido, sem dormir. */
  guardTimeout(latencyMs, request) {
    if (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 && latencyMs > request.timeoutMs) {
      throw new AiProviderError('TIMEOUT', { providerCode: SANDBOX_CODE, upstreamCode: 'SANDBOX_SLOW' });
    }
  }

  async generate(request = {}) {
    const entry = this.modelEntry(request.model, 'generate');
    const entrada = lastUser(request.messages);
    const falha = failureFixture(entrada, SANDBOX_CODE);
    if (falha) throw falha;
    const out = sandboxGenerate({ system: request.system || '', messages: request.messages || [] });
    this.guardTimeout(out.latencyMs, request);
    const toolRequests = (out.toolRequests || []).map((t) => ({ name: t.name, arguments: t.args }));
    return {
      text: out.text,
      toolRequests,
      usage: { tokensIn: out.inputTokens, tokensOut: out.outputTokens },
      costAmount: microsToAmount(out.costMicros),
      finishReason: toolRequests.length ? 'tool_calls' : 'stop',
      providerRequestId: `sandbox-${out.digest.slice(0, 16)}`,
      latencyMs: out.latencyMs,
      model: entry.model,
    };
  }

  async embed(request = {}) {
    const entry = this.modelEntry(request.model, 'embed');
    const inputs = Array.isArray(request.inputs) ? request.inputs : [];
    if (inputs.length === 0 || inputs.some((x) => typeof x !== 'string')) throw new AiProviderError('VALIDATION', { providerCode: SANDBOX_CODE, upstreamCode: 'INPUTS_INVALID' });
    const tokensIn = inputs.reduce((a, t) => a + tokensOf(t), 0);
    return {
      vectors: inputs.map(sandboxEmbedText),
      dimensions: SANDBOX_DIMENSIONS,
      usage: { tokensIn, tokensOut: 0 },
      costAmount: this.costFor(entry, { tokensIn, tokensOut: 0 }),
      providerRequestId: `sandbox-${hash(inputs.join('\n')).slice(0, 16)}`,
    };
  }

  async transcribe(request = {}) {
    const entry = this.modelEntry(request.model, 'transcribe');
    const text = `Transcrição de teste ${hash(`${request.fileRef}|${request.language || ''}`).slice(0, 8)}.`;
    const tokensOut = tokensOf(text);
    return {
      text, segments: [{ start: 0, end: 1, text }], usage: { tokensIn: 0, tokensOut }, costAmount: this.costFor(entry, { tokensIn: 0, tokensOut }),
      providerRequestId: `sandbox-${hash(request.fileRef).slice(0, 16)}`,
    };
  }

  async analyzeImage(request = {}) {
    const entry = this.modelEntry(request.model, 'analyzeImage');
    const digest = hash(`${request.imageRef}|${request.prompt || ''}`);
    const text = `Imagem de teste ${digest.slice(0, 8)}.`;
    const tokensIn = tokensOf(request.prompt || '');
    const tokensOut = tokensOf(text);
    return {
      text, structured: { digest: digest.slice(0, 16) }, usage: { tokensIn, tokensOut }, costAmount: this.costFor(entry, { tokensIn, tokensOut }),
      providerRequestId: `sandbox-${digest.slice(0, 16)}`,
    };
  }
}

module.exports = { SandboxAdapter };
