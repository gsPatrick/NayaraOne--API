'use strict';

const { rows, one, blocker } = require('./sql');

const USAGE_DAYS = 30;

/** Impacto de revogar uma credencial de API (linha 13): consumidor, scopes que deixam de valer e uso dos últimos 30 dias. */
async function apiClientRevoke({ id, transaction }) {
  const c = await one(
    transaction,
    `SELECT c.id, c.name, c.client_id, c.status, c.scopes, k.name AS consumer_name, k.id AS consumer_id FROM governance.api_clients c JOIN governance.api_consumers k ON k.id = c.consumer_id WHERE c.id = :id`,
    { id }, 'Credencial não encontrada.', 'GOV_API_CLIENT_NOT_FOUND'
  );
  const [usage] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM governance.api_consumer_usage WHERE consumer_id = :cid AND last_seen_at >= now() - make_interval(days => :days)`, { cid: c.consumer_id, days: USAGE_DAYS });
  const scopes = Array.isArray(c.scopes) ? c.scopes : [];
  return {
    code: c.client_id,
    label: `${c.name} (${c.consumer_name})`,
    impact: {
      counts: { credentials: 1, scopes: scopes.length, routesUsedLast30Days: usage.n },
      totalAmountCents: 0,
      blockers: c.status === 'REVOKED' ? [blocker('CLIENT_ALREADY_REVOKED', 'a credencial já foi revogada')] : [],
      items: [{ type: 'CONSUMER', id: c.consumer_id, label: c.consumer_name }, ...scopes.map((s) => ({ type: 'SCOPE', id: s, label: s }))],
    },
  };
}

/** Impacto de criar uma credencial (linha 13): o que a nova credencial passa a poder acessar. O código a digitar é o nome pedido. */
async function apiClientCreate({ body }) {
  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  const scopes = Array.isArray(body && body.scopes) ? body.scopes.filter((s) => typeof s === 'string') : [];
  const blockers = [];
  if (!name) blockers.push(blocker('NAME_REQUIRED', 'informe o nome da credencial'));
  if (scopes.length === 0) blockers.push(blocker('SCOPES_REQUIRED', 'informe ao menos um scope'));
  return { code: name, label: name || 'Nova credencial', impact: { counts: { credentials: 1, scopes: scopes.length }, totalAmountCents: 0, blockers, items: scopes.map((s) => ({ type: 'SCOPE', id: s, label: s })) } };
}

module.exports = { apiClientRevoke, apiClientCreate };
