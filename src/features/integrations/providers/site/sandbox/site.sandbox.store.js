'use strict';

const crypto = require('node:crypto');

/**
 * Páginas do site de laboratório (M9-D259), por connection e `pageKey` (em memória: o sandbox não tem rede). Cada operação com efeito (publicar com chave nova, despublicar uma página
 * no ar) gera uma nova "publicação" (`publicationId`), que é o identificador da operação no site e o que o envio guarda como recurso externo.
 */
const pages = new Map();
const byKey = new Map();
const faultsUsed = new Set();
const calls = [];

const sha = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex');
const k = (connectionId, pageKey) => `${connectionId}|${pageKey}`;
const erroHttp = (status, message) => Object.assign(new Error(message), { status });

const publicationOf = (page) => `pub-${sha(page.connectionId, page.pageKey, page.revision).slice(0, 16)}`;
const log = (connectionId, operation, pageKey) => calls.push({ connectionId, operation, pageKey, at: Date.now() });

/** Cria ou atualiza a página. A mesma chave de idempotência devolve a mesma publicação (nada duplica); chave nova com a página no ar ou removida abre uma publicação nova. */
function publish(connectionId, idempotencyKey, req, delayMs) {
  const kk = byKey.get(`${connectionId}|${idempotencyKey}`);
  if (kk) return { page: pages.get(kk), created: false };
  const key = k(connectionId, req.pageKey);
  let page = pages.get(key);
  const created = !page;
  if (!page) page = { connectionId, pageKey: req.pageKey, pageId: `pg-${sha(connectionId, req.pageKey).slice(0, 8)}`, revision: 0, publishCount: 0 };
  page.revision += 1;
  page.publishCount += 1;
  Object.assign(page, { slug: req.slug, locale: req.locale || null, contentHash: req.contentHash || null, contentRef: req.contentRef || null, state: 'pending', liveAt: Date.now() + delayMs, lastKey: idempotencyKey });
  page.publicationId = publicationOf(page);
  pages.set(key, page);
  byKey.set(`${connectionId}|${idempotencyKey}`, key);
  log(connectionId, 'publishPage', req.pageKey);
  return { page, created };
}

const find = (connectionId, pageKey) => pages.get(k(connectionId, pageKey)) || null;
const findByIdempotencyKey = (connectionId, idempotencyKey) => { const key = byKey.get(`${connectionId}|${idempotencyKey}`); return key ? pages.get(key) : null; };

/** Estado visível agora: pending até `liveAt`, depois live; removida fica removed. */
const stateAt = (page, now = Date.now()) => (page.state === 'removed' ? 'removed' : (now >= page.liveAt ? 'live' : 'pending'));

/** Despublica (idempotente): página inexistente ou já removida não é erro. Página no ar ou pendente abre uma publicação nova (a remoção). */
function unpublish(connectionId, pageKey) {
  const page = find(connectionId, pageKey);
  log(connectionId, 'unpublishPage', pageKey);
  if (!page || page.state === 'removed') return page;
  page.revision += 1;
  page.state = 'removed';
  page.publicationId = publicationOf(page);
  return page;
}

/** Falha injetada pela connection (`config.sandbox_fault`): TIMEOUT_AFTER_SEND acontece uma vez por chave, depois de a página já ter sido criada. */
function afterSendTimeout(ctx, idempotencyKey) {
  const fault = String((ctx.connection.config || {}).sandbox_fault || '').toUpperCase();
  const id = `${ctx.connection.id}|${idempotencyKey}`;
  if (fault !== 'TIMEOUT_AFTER_SEND' || faultsUsed.has(id)) return false;
  faultsUsed.add(id);
  return true;
}

module.exports = { publish, unpublish, find, findByIdempotencyKey, stateAt, afterSendTimeout, log, erroHttp, calls: () => calls.slice(), pagesOf: (connectionId) => [...pages.values()].filter((p) => p.connectionId === connectionId), reset: () => { pages.clear(); byKey.clear(); faultsUsed.clear(); calls.length = 0; } };
