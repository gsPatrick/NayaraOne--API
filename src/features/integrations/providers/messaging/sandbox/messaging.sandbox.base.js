'use strict';

const { MessagingAdapter } = require('../messaging.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { raiseFault, readWire, faultOf, erroHttp } = require('../../../registry/sandboxFaults');
const store = require('./messaging.sandbox.store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { signedMediaLink } = require('../messaging.mediaLink');

/**
 * Base dos adapters de mensageria de laboratório (M9-D229 3.2 item 5): o mesmo comportamento de envio, entrega com atraso, idempotência e falhas injetadas
 * em dois vocabulários de fornecedor (`messaging-sandbox` e `messaging-alt-sandbox`). Quem herda declara só o que muda: código, prefixo dos ids, nomes dos campos
 * da resposta, tabela de status, verificador do webhook, esquemas e conversão do evento. A suíte de troca de provider (M9-D221) prova que o resultado interno é igual.
 */
class MessagingSandboxBase extends MessagingAdapter {
  /** { prefix, idField, statusField, vocab: { QUEUED, SENT, DELIVERED, READ, FAILED } } no vocabulário do fornecedor. */
  wire() { throw new Error('wire() não implementado'); }

  supportedVersions() { return ['v1']; }

  supportsIdempotency(operation) { return ['sendText', 'sendTemplate', 'sendMedia'].includes(operation); }

  classifyError(e) { return classifyHttpError(e); }

  /** Atraso (ms) da entrega simulada: `config.sandbox_delivery_delay_ms` da connection (sem atraso por padrão). */
  delayOf(ctx) { return Number((((ctx && ctx.connection && ctx.connection.config) || {}).sandbox_delivery_delay_ms)) || 0; }

  /** Nunca lança: falha injetada vira ok:false (livro, contract test 10). `opts.headers` leva o cabeçalho x-sandbox-fail. */
  async healthCheck(ctx, opts) {
    try {
      const contexto = ctx || this.ctx;
      const fault = faultOf(contexto, opts || {});
      if (fault) return { ok: false, latencyMs: 0, detail: 'Falha simulada pelo sandbox.' };
      return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' };
    } catch {
      return { ok: false, latencyMs: 0, detail: 'Falha ao testar o sandbox.' };
    }
  }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toLowerCase();
    const achado = Object.entries(this.wire().vocab).find(([, externo]) => externo.toLowerCase() === s);
    return achado ? achado[0] : (this.extraStatus ? this.extraStatus(s) : null);
  }

  /** Resposta do fornecedor no fio -> saída normalizada do port (status desconhecido: 502 INTEGRATION_STATUS_UNMAPPED). */
  parse(wire, resposta) {
    return { externalRequestId: null, externalResourceId: resposta[wire.idField] ?? null, status: this.normalizeStatus(resposta[wire.statusField]) };
  }

  async send(ctx, request, meta, tipo, dados) {
    const wire = this.wire();
    await raiseFault(ctx, request, 'write');
    const chave = (meta && meta.idempotencyKey) || request.idempotencyKey || null;
    const { message } = store.create(ctx.connection.id, chave, wire.prefix, { tipo, to: request.to, ...dados });
    const resposta = readWire(ctx, request, { [wire.idField]: message.id, [wire.statusField]: wire.vocab.SENT }, wire.statusField);
    return this.parse(wire, resposta);
  }

  async sendText(ctx, request, meta) { return this.send(ctx, request, meta, 'text', { text: request.text }); }

  async sendTemplate(ctx, request, meta) { return this.send(ctx, request, meta, 'template', { templateName: request.templateName }); }

  /** A mídia vai por link assinado de curta duração, feito agora (M9-D230 3.3); o fornecedor recebe o link, nunca o arquivo. */
  async sendMedia(ctx, request, meta) {
    await raiseFault(ctx, request, 'write');
    const mediaLink = UUID.test(String(request.mediaRef)) ? await signedMediaLink(meta, request.mediaRef) : null; // referência que não é arquivo do sistema segue sem link
    return this.send(ctx, request, meta, 'media', { mediaRef: request.mediaRef, mediaLink });
  }

  async getStatus(ctx, request) {
    const wire = this.wire();
    await raiseFault(ctx, request, 'read');
    const message = store.findById(ctx.connection.id, request.externalResourceId);
    if (!message) throw erroHttp(404, 'Mensagem não encontrada no fornecedor.');
    const resposta = readWire(ctx, request, { [wire.idField]: message.id, [wire.statusField]: wire.vocab[store.statusAt(message, this.delayOf(ctx))] }, wire.statusField);
    return this.parse(wire, resposta);
  }

  async findByIdempotencyKey(ctx, request) {
    const m = store.findByKey(ctx.connection.id, request.idempotencyKey);
    return m ? { found: true, externalResourceId: m.id, status: this.wire().vocab.SENT } : { found: false };
  }
}

module.exports = { MessagingSandboxBase };
