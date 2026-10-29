'use strict';

// Redes sociais programáveis (M9-D239): cada rede guarda os posts pela chave de idempotência (como uma rede que respeita a chave),
// responde às consultas do motor (por chave e pela listagem recente) e aceita falhas injetadas: o pedido chega e a resposta se perde
// (`recebeEDaTimeout`), o pedido nem chega (`semReceber`) e erro HTTP (`erro`). Cada passo da fila vale uma vez.
const { SocialAdapter } = require('../../../src/features/integrations/providers/social/social.port');
const { classifyHttpError } = require('../../../src/features/integrations/registry/classifyHttpError');
const { sequelize } = require('../../../src/models');
const { seedCatalog } = require('../../../src/features/integrations/providers/catalog.seed');

const timeout = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
const REDES = Object.freeze(['qa-m9-instagram', 'qa-m9-facebook', 'qa-m9-linkedin']);

/** Cadastra no catálogo de teste as três redes (fornecedores SOCIAL, sandbox) — idempotente. */
const semearRedes = () => sequelize.transaction(async (transaction) => {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction }); // o catálogo é do administrador da plataforma
  return seedCatalog(sequelize, transaction, REDES.map((code) => ({
    code, displayName: `Rede ${code} (teste)`, domain: 'SOCIAL', capabilities: ['publishPost', 'getPostStatus', 'deletePost'], supportedVersions: ['v1'], criticality: 'LOW', sandboxAvailable: true,
  })));
});

function redeProgramavel(code) {
  const S = {
    chamadas: [], consultas: [], posts: new Map(), todos: [], filas: {}, consultaFalha: null, windowDays: null,
    fila(op, passos) { S.filas[op] = passos.slice(); },
    registrar(chave, text, status = 'PUBLISHED', ageMs = 0) { const p = { id: `post-${S.todos.length + 1}`, text, status, at: Date.now() - ageMs }; S.todos.push(p); if (chave) S.posts.set(chave, p); return p; },
  };
  class Rede extends SocialAdapter {
    providerCode() { return code; }

    capabilities() { return ['publishPost', 'getPostStatus', 'deletePost']; }

    supportedVersions() { return ['v1']; }

    async healthCheck() { return { ok: true, latencyMs: 1, detail: 'ok' }; }

    classifyError(e) { return classifyHttpError(e); }

    mapStatus(s) { return s == null ? null : String(s).toUpperCase(); }

    supportsIdempotency() { return true; }

    confirmsOnResponse(op) { return op === 'publishPost'; }

    async publishPost(_ctx, request, meta) {
      S.chamadas.push({ op: 'publishPost', request, meta });
      const passo = (S.filas.publishPost && S.filas.publishPost.length ? S.filas.publishPost.shift() : null) || {};
      if (passo.erro) throw passo.erro;
      if (passo.semReceber) throw timeout();
      const chave = meta && meta.idempotencyKey;
      const post = (chave && S.posts.get(chave)) || S.registrar(chave, request.text);
      if (passo.recebeEDaTimeout) throw timeout();
      return { externalRequestId: null, externalResourceId: post.id, status: post.status };
    }

    async findPostByKey(_ctx, request) {
      S.consultas.push({ metodo: 'key', request });
      if (S.consultaFalha) throw S.consultaFalha;
      const p = S.posts.get(request.idempotencyKey);
      return p ? { externalResourceId: p.id, status: p.status } : null;
    }

    async findByReference(_ctx, request) {
      S.consultas.push({ metodo: 'reference', request });
      S.windowDays = request.windowDays;
      if (S.consultaFalha) throw S.consultaFalha;
      const desde = Date.now() - request.windowDays * 86400000;
      const p = S.todos.find((x) => x.text === request.text && x.at >= desde);
      return p ? { externalResourceId: p.id, status: p.status } : null;
    }

    async getPostStatus(_ctx, request) {
      S.consultas.push({ metodo: 'status', request });
      const p = S.todos.find((x) => x.id === request.externalResourceId);
      if (!p) throw Object.assign(new Error('nf'), { status: 404 });
      return { externalResourceId: p.id, status: p.status };
    }

    async deletePost(_ctx, request) {
      const p = S.todos.find((x) => x.id === request.externalResourceId);
      if (p) p.status = 'DELETED';
      return { externalResourceId: request.externalResourceId, status: 'DELETED' };
    }
  }
  Rede.S = S;
  return Rede;
}

module.exports = { redeProgramavel, semearRedes, timeout, REDES };
