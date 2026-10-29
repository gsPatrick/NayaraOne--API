'use strict';

const crypto = require('node:crypto');

/** Envelopes do sandbox de assinatura, por connection e chave de idempotência (em memória: o sandbox não tem rede nem banco), M9-D236. */
const envelopes = new Map();
const faultsUsed = new Set();

const sha = (...partes) => crypto.createHash('sha256').update(partes.join('|')).digest('hex');
const keyOf = (connectionId, chave) => `${connectionId}|${chave}`;
const erroHttp = (status, message) => Object.assign(new Error(message), { status });

/** Signatários do pedido: objetos { personId, email, name } ou, nos testes de contrato antigos, só o identificador. */
const normalizeSigners = (signers) => (Array.isArray(signers) ? signers : []).map((s) => (s && typeof s === 'object' ? s : { personId: String(s) }));

/** Cria (ou devolve, pela mesma chave) o envelope. Ids determinísticos: o mesmo pedido gera sempre o mesmo envelope e os mesmos signatários. */
function createEnvelope(connectionId, chave, request, prefix) {
  const k = keyOf(connectionId, chave);
  if (!envelopes.has(k)) {
    const id = `${prefix}-env-${sha(connectionId, chave).slice(0, 16)}`;
    const signers = normalizeSigners(request.signers).map((s) => ({ personId: s.personId ?? null, email: s.email ?? null, name: s.name ?? null, externalSignerId: `${prefix}-sig-${sha(id, s.personId ?? s.email ?? '').slice(0, 16)}` }));
    envelopes.set(k, { id, key: chave, connectionId, documentRef: request.documentRef, documentSha256: request.documentSha256 || null, signers, status: 'PENDING', at: Date.now() });
  }
  return envelopes.get(k);
}

const findByKey = (connectionId, chave) => envelopes.get(keyOf(connectionId, chave)) || null;
const findById = (connectionId, id) => [...envelopes.values()].find((e) => e.connectionId === connectionId && e.id === id) || null;
const findByDocument = (connectionId, documentRef) => [...envelopes.values()].find((e) => e.connectionId === connectionId && String(e.documentRef) === String(documentRef)) || null;

/** O arquivo assinado que o sandbox devolve: texto determinístico que cita o envelope e o hash do original (o hash do arquivo assinado difere do original). */
const signedDocument = (envelopeId, originalSha256) => Buffer.from(`%SANDBOX-SIGNED-DOCUMENT\nenvelope:${envelopeId}\noriginal:${originalSha256 || 'desconhecido'}\n`, 'utf8');

/** Falha injetada pela connection (`config.sandbox_fault`): TIMEOUT_AFTER_SEND (uma vez por chave, depois de criar o envelope), HTTP_401 e HTTP_503. */
function injectFault(ctx, envelopeId) {
  const fault = (ctx.connection.config || {}).sandbox_fault;
  if (fault === 'HTTP_401') throw erroHttp(401, 'Credencial recusada');
  if (fault === 'HTTP_503') throw erroHttp(503, 'Fornecedor indisponível');
  return fault === 'TIMEOUT_AFTER_SEND' && !faultsUsed.has(envelopeId) ? (faultsUsed.add(envelopeId), true) : false;
}

const reset = () => { envelopes.clear(); faultsUsed.clear(); };

module.exports = { createEnvelope, findByKey, findById, findByDocument, signedDocument, injectFault, erroHttp, normalizeSigners, sha, reset };
