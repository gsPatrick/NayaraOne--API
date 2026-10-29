'use strict';

const crypto = require('crypto');
const { SocialAdapter } = require('../social.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { statusEventSchemas } = require('../../../registry/webhookSchemas');

const STATUS = Object.freeze({ QUEUED: 'QUEUED', PUBLISHED: 'PUBLISHED', FAILED: 'FAILED', DELETED: 'DELETED' });
/** Falhas que o laboratório pode injetar na connection (`config.sandbox_fault`): timeout depois do envio (uma vez por post), 401 e 503. */
const FAULTS = Object.freeze(['TIMEOUT_AFTER_SEND', 'HTTP_401', 'HTTP_503']);

/** Os posts do sandbox, por connection e chave de idempotência (em memória: o sandbox não tem rede nem banco). */
const posts = new Map();
const faultsUsed = new Set();

const idDe = (connectionId, chave) => `sbx-post-${crypto.createHash('sha256').update(`${connectionId}|${chave}`).digest('hex').slice(0, 16)}`;
const erroHttp = (status, message) => Object.assign(new Error(message), { status });

/**
 * social-sandbox (M9-D239): rede social simulada. Guarda o post pela chave de idempotência (a mesma chave devolve o mesmo post, como uma
 * rede de verdade que respeita a chave), responde `findPostByKey` e a listagem recente (`findByReference`), e deixa o laboratório injetar
 * falha na connection para provar o isolamento por rede. Sem webhook de status, a resposta com o id do post confirma (`confirmsOnResponse`).
 */
class SocialSandboxAdapter extends SocialAdapter {
  providerCode() { return 'social-sandbox'; }

  capabilities() { return ['publishPost', 'getPostStatus', 'deletePost']; }

  supportedVersions() { return ['v1']; }

  /** Webhook do sandbox: HMAC-SHA256 com horário assinado (cabeçalho x-signature: t=...,v1=...), M9-D211 3.3. */
  webhookVerifier() { return hmacWithTimestamp(); }

  /** Esquema do evento de status (M9-D213 3.3). */
  webhookSchemas() { return statusEventSchemas(); }


  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  supportsIdempotency() { return true; }

  confirmsOnResponse(operation) { return operation === 'publishPost'; }

  async publishPost(ctx, request, meta) {
    const connectionId = ctx.connection.id;
    const chave = (meta && meta.idempotencyKey) || crypto.createHash('sha256').update(String(request.text)).digest('hex');
    const fault = (ctx.connection.config || {}).sandbox_fault;
    if (fault === 'HTTP_401') throw erroHttp(401, 'Token da rede recusado');
    if (fault === 'HTTP_503') throw erroHttp(503, 'Rede indisponível');
    const id = idDe(connectionId, chave);
    if (!posts.has(`${connectionId}|${chave}`)) posts.set(`${connectionId}|${chave}`, { id, text: String(request.text), status: STATUS.PUBLISHED, at: Date.now() });
    if (fault === 'TIMEOUT_AFTER_SEND' && !faultsUsed.has(id)) {
      faultsUsed.add(id);
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    }
    const post = posts.get(`${connectionId}|${chave}`);
    return { externalRequestId: null, externalResourceId: post.id, status: post.status };
  }

  async findPostByKey(ctx, request) {
    const post = posts.get(`${ctx.connection.id}|${request.idempotencyKey}`);
    return post ? { externalResourceId: post.id, status: post.status } : null;
  }

  /** Listagem recente da conta: o primeiro post com o mesmo texto dentro da janela de dias. */
  async findByReference(ctx, request) {
    const desde = Date.now() - (Number(request.windowDays) || 7) * 86400000;
    const achado = [...posts.entries()].find(([k, p]) => k.startsWith(`${ctx.connection.id}|`) && p.at >= desde && p.text === String(request.text));
    return achado ? { externalResourceId: achado[1].id, status: achado[1].status } : null;
  }

  async getPostStatus(ctx, request) {
    const post = [...posts.entries()].find(([k, p]) => k.startsWith(`${ctx.connection.id}|`) && p.id === request.externalResourceId);
    if (!post) throw erroHttp(404, 'Post não encontrado');
    return { externalRequestId: null, externalResourceId: post[1].id, status: post[1].status };
  }

  async deletePost(ctx, request) {
    const post = [...posts.entries()].find(([k, p]) => k.startsWith(`${ctx.connection.id}|`) && p.id === request.externalResourceId);
    if (!post) throw erroHttp(404, 'Post não encontrado');
    post[1].status = STATUS.DELETED;
    return { externalRequestId: null, externalResourceId: post[1].id, status: STATUS.DELETED };
  }
}

module.exports = { SocialSandboxAdapter, STATUS, FAULTS, resetSocialSandbox: () => { posts.clear(); faultsUsed.clear(); } };
