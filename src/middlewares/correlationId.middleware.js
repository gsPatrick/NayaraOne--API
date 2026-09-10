'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

/**
 * correlationId — TEC-08 (homologação 10/09/2026): não havia nenhum identificador ligando uma
 * requisição HTTP às linhas de auditoria/eventos que ela gera — impossível reconstruir, dado
 * um problema relatado, TODAS as ações que uma única requisição do usuário disparou.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: em vez de alterar toda chamada de
 * `registrarAuditoria`/`publishDomainEvent` espalhada por ~150 pontos do código (risco alto de
 * regressão numa mudança tão ampla sob prazo), usamos `AsyncLocalStorage` (nativo do Node) pra
 * propagar o correlationId implicitamente por toda a cadeia de chamadas assíncronas de uma
 * mesma requisição — `registrarAuditoria` lê o valor automaticamente do contexto ativo, sem
 * precisar que cada chamador passe o parâmetro manualmente.
 *
 * Aceita um `X-Correlation-Id` vindo do cliente (rastreamento ponta a ponta real, front -> API)
 * ou gera um novo UUID se não vier nenhum. Sempre devolve o valor usado no header de resposta.
 */
const correlationIdStorage = new AsyncLocalStorage();

// "audit"."audit_log".correlation_id e "integration"."outbox_events".correlation_id são
// colunas UUID de verdade (não texto livre) — um header vindo do cliente que não seja um UUID
// válido faria o INSERT falhar (erro 500) na primeira auditoria/evento da requisição. Nunca
// confia cegamente no valor recebido: só reaproveita se for um UUID válido, senão gera um novo.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function correlationIdMiddleware(req, res, next) {
  const incoming = req.headers['x-correlation-id'];
  const correlationId = (typeof incoming === 'string' && UUID_PATTERN.test(incoming.trim()))
    ? incoming.trim()
    : crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  correlationIdStorage.run({ correlationId }, () => next());
}

function getCurrentCorrelationId() {
  return correlationIdStorage.getStore()?.correlationId || null;
}

// runWithCorrelationId — usado por testes (e por jobs em background que queiram amarrar um
// lote de trabalho a um correlationId próprio) para entrar no mesmo contexto que a requisição
// HTTP normalmente cria, sem precisar de um servidor Express de verdade.
function runWithCorrelationId(correlationId, fn) {
  return correlationIdStorage.run({ correlationId }, fn);
}

module.exports = { correlationIdMiddleware, getCurrentCorrelationId, runWithCorrelationId };
