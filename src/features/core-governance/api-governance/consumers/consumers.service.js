'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getSetting } = require('../../../settings/settings.service');
const { pageResult, parsePagination } = require('../standards/pagination.helper');
const E = require('./consumers.errors');
const S = require('./consumers.settings');
const repository = require('./consumers.repository');
const deprecationsRepo = require('./deprecations.repository');
const { KINDS, readFilters, pageOfConsumers, usageOf } = require('./consumers.list');
const { daysToSunset } = require('./days');
const { clearContextCache } = require('./context');

const EXTERNAL_KINDS = Object.freeze(['PARTNER', 'PROVIDER']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_NAME = 'Front web Nayara One';

/**
 * GET /api-governance/consumers (M9-D841 §3.5): consumidores da empresa com os dados do catálogo, as versões usadas (major do catálogo mais as marcas MAJOR:<n> do uso), `lastSeenAt`,
 * as deprecações que os afetam (uso do alvo dentro da janela `consumidor_ativo_dias`) e `daysToSunset` (o menor entre elas).
 */
async function listConsumers({ tenant, query = {}, transaction }) {
  const filters = readFilters(query);
  const paging = await parsePagination(query, tenant, transaction);
  const activeDays = Number(await getSetting(S.ATIVO_DIAS_KEY, tenant, transaction, S.CONSUMERS_SETTING_DEFAULTS[S.ATIVO_DIAS_KEY]));
  const { items, total } = await pageOfConsumers({ companyId: tenant.companyId, filters, activeDays, limit: paging.limit, offset: paging.offset }, transaction);
  const usage = await usageOf(tenant.companyId, items.map((item) => item.id), transaction);
  const deprecations = (await deprecationsRepo.listActive(tenant.companyId, transaction)).filter((row) => row.status !== 'CANCELLED');
  const now = new Date();
  const windowStart = now.getTime() - activeDays * 86400000;
  const out = items.map((consumer) => {
    const rows = usage.filter((row) => row.consumerId === consumer.id);
    const versions = new Set([consumer.apiVersionUsed, ...rows.map((row) => /^MAJOR:(\d+)$/.exec(row.targetKey)).filter(Boolean).map((m) => Number(m[1]))]);
    const recent = new Set(rows.filter((row) => new Date(row.lastSeenAt).getTime() >= windowStart).map((row) => row.targetKey));
    const affecting = deprecations.filter((row) => recent.has(row.target)).map((row) => ({
      id: row.id, target: row.target, announcedAt: row.announcedAt, sunsetAt: row.sunsetAt, status: row.status, replacement: row.replacement, daysToSunset: daysToSunset(row.sunsetAt, now),
    }));
    return {
      ...consumer, versionsUsed: [...versions].sort((a, b) => a - b), deprecations: affecting,
      daysToSunset: affecting.length ? Math.min(...affecting.map((row) => row.daysToSunset)) : null,
    };
  });
  return pageResult(out, paging, total);
}

/**
 * Cadastra o consumidor de uma credencial externa no mesmo ato da credencial (M9-D844 chama esta função; não há rota de cadastro). Só PARTNER ou PROVIDER; o responsável é obrigatório
 * e deve ser usuário ativo da empresa; `clientId` liga ao cadastro de credencial. Nome ou credencial repetidos: 409.
 */
async function registerConsumer({ tenant, actorUserId, name, kind, ownerUserId, contactEmail = null, clientId = null, apiVersionUsed = 1, transaction }) {
  const problems = [];
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) problems.push({ field: 'name', reason: 'informe o nome (até 120 caracteres)' });
  if (!EXTERNAL_KINDS.includes(kind)) problems.push({ field: 'kind', reason: `use ${EXTERNAL_KINDS.join(' ou ')}` });
  if (typeof ownerUserId !== 'string' || !UUID.test(ownerUserId) || !(await repository.isActiveMember(tenant.companyId, ownerUserId, transaction))) problems.push({ field: 'ownerUserId', reason: 'o responsável deve ser usuário ativo da empresa' });
  if (contactEmail !== null && (typeof contactEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(contactEmail) || contactEmail.length > 254)) problems.push({ field: 'contactEmail', reason: 'e-mail inválido' });
  if (!Number.isInteger(apiVersionUsed) || apiVersionUsed < 1) problems.push({ field: 'apiVersionUsed', reason: 'major inválida' });
  if (problems.length) throw E.consumerInvalid({ problems });
  const row = await repository.insertConsumer({ groupId: tenant.groupId, companyId: tenant.companyId, name: name.trim(), kind, ownerUserId, contactEmail, apiVersionUsed, clientId }, transaction);
  if (!row) throw E.consumerExists();
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'api.consumer.created', entityType: 'ApiConsumer', entityId: row.id,
    beforeJson: null, afterJson: { name: row.name, kind: row.kind, ownerUserId: row.ownerUserId, apiVersionUsed: row.apiVersionUsed, clientId: row.clientId }, reason: `Consumidor de API ${row.name} (${row.kind}) cadastrado.`,
  }, transaction);
  clearContextCache(tenant.companyId);
  return row;
}

/** Empresa criada depois da semente: cria o consumidor do front web na primeira chamada com o valor semeado de X-Client-App. Sem usuário ativo na empresa, não cria. */
async function ensureWebConsumer({ tenant, appKey, transaction }) {
  const ownerUserId = await repository.oldestActiveMember(tenant.companyId, transaction);
  if (!ownerUserId) return null;
  const created = await repository.insertConsumer({ groupId: tenant.groupId, companyId: tenant.companyId, name: WEB_NAME, kind: 'APP', ownerUserId, appKey }, transaction);
  return created || repository.findByAppKey(tenant.companyId, appKey, transaction);
}

module.exports = { listConsumers, registerConsumer, ensureWebConsumer, KINDS, EXTERNAL_KINDS };
