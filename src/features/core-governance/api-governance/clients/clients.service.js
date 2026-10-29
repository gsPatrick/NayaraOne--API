'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getSetting } = require('../../../settings/settings.service');
const { parsePagination, pageResult } = require('../standards/pagination.helper');
const { registerConsumer, clearContextCache } = require('../consumers');
const E = require('./clients.errors');
const S = require('./clients.settings');
const repository = require('./clients.repository');
const { newClientId, newSecret, hashSecret } = require('./secret');

const KINDS = Object.freeze(['PARTNER', 'PROVIDER']);
const STATUSES = Object.freeze(['ACTIVE', 'REVOKED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Scopes pedidos na criação: lista não vazia de códigos do catálogo (sem repetição). Devolve a lista limpa ou os problemas por campo. */
async function checkScopes(raw, transaction) {
  if (!Array.isArray(raw) || !raw.length) return { problems: [{ field: 'scopes', reason: 'informe ao menos um scope' }] };
  const catalog = new Set((await repository.scopeCatalog(transaction)).map((row) => row.code));
  const unknown = raw.filter((scope) => typeof scope !== 'string' || !catalog.has(scope));
  if (unknown.length) return { problems: [{ field: 'scopes', reason: `scope fora do catálogo: ${unknown.map(String).join(', ')}`, allowed: [...catalog] }] };
  return { scopes: [...new Set(raw)] };
}

/**
 * Cria a credencial (M9-D844 §3.4) e o consumidor da M9-D841 no mesmo ato, na transação da requisição. Devolve o segredo em claro UMA vez; o banco guarda o hash. Sem rotação.
 */
async function createClient({ tenant, actorUserId, body = {}, transaction }) {
  const problems = [];
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) problems.push({ field: 'name', reason: 'informe o nome (até 120 caracteres)' });
  if (!KINDS.includes(body.kind)) problems.push({ field: 'kind', reason: `use ${KINDS.join(' ou ')}` });
  if (typeof body.ownerUserId !== 'string' || !UUID.test(body.ownerUserId)) problems.push({ field: 'ownerUserId', reason: 'informe o responsável (usuário ativo da empresa)' });
  const checked = await checkScopes(body.scopes, transaction);
  if (checked.problems) problems.push(...checked.problems);
  if (problems.length) throw E.clientInvalid({ problems });
  const cost = Number(await getSetting(S.SECRET_COST_KEY, tenant, transaction, S.CLIENTS_SETTING_DEFAULTS[S.SECRET_COST_KEY]));
  const clientId = newClientId();
  const clientSecret = newSecret();
  const secretHash = await hashSecret(clientSecret, cost);
  const consumer = await registerConsumer({ tenant, actorUserId, name: body.name, kind: body.kind, ownerUserId: body.ownerUserId, contactEmail: body.contactEmail === undefined ? null : body.contactEmail, clientId, transaction });
  const row = await repository.insertClient({ groupId: tenant.groupId, companyId: tenant.companyId, consumerId: consumer.id, name: body.name.trim(), clientId, secretHash, scopes: checked.scopes, createdBy: actorUserId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'api.client.created', entityType: 'ApiClient', entityId: row.id,
    beforeJson: null, afterJson: { name: row.name, clientId, kind: consumer.kind, ownerUserId: consumer.ownerUserId, scopes: row.scopes, consumerId: consumer.id }, reason: `Credencial de API ${row.name} (${consumer.kind}) criada com os scopes ${row.scopes.join(', ')}.`,
  }, transaction);
  return { ...row, kind: consumer.kind, ownerUserId: consumer.ownerUserId, clientSecret };
}

/** GET /api-governance/clients: credenciais da empresa (nunca o segredo nem o hash), filtro `status`, paginação única. */
async function listClients({ tenant, query = {}, transaction }) {
  if (query.status !== undefined && !STATUSES.includes(query.status)) throw E.clientInvalid({ problems: [{ field: 'status', reason: `use ${STATUSES.join(' ou ')}` }] });
  const paging = await parsePagination(query, tenant, transaction);
  const { items, total } = await repository.listClients({ companyId: tenant.companyId, status: query.status || null, limit: paging.limit, offset: paging.offset }, transaction);
  return pageResult(items, paging, total);
}

/** Revoga (M9-D844 §3.4): a credencial deixa de obter token e o token já emitido passa a ser recusado na chamada seguinte, porque cada chamada externa confere o status. */
async function revokeClient({ tenant, actorUserId, id, transaction }) {
  if (!UUID.test(String(id))) throw E.clientNotFound();
  const current = await repository.findById(tenant.companyId, id, transaction, true);
  if (!current) throw E.clientNotFound();
  if (current.status === 'REVOKED') throw E.clientAlreadyRevoked();
  const row = await repository.markRevoked(tenant.companyId, id, actorUserId, transaction);
  await repository.select("UPDATE governance.api_consumers SET status = 'RETIRED', updated_at = now() WHERE id = :id AND company_id = :companyId RETURNING id", { id: current.consumerId, companyId: tenant.companyId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'api.client.revoked', entityType: 'ApiClient', entityId: id,
    beforeJson: { status: 'ACTIVE' }, afterJson: { status: 'REVOKED', clientId: row.clientId }, reason: `Credencial de API ${row.name} revogada.`,
  }, transaction);
  clearContextCache(tenant.companyId);
  return row;
}

module.exports = { createClient, listClients, revokeClient, KINDS, STATUSES };
