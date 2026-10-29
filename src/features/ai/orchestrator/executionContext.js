'use strict';

// M9-D017 — ExecutionContext: em nome de quem a NAY age. Construído no SERVIDOR, nunca pelo modelo:
// { actor: USER | SERVICE, groupId, companyId, permissions (as do ator), roles, correlationId, runId }.
// A permissão que a NAY usa é a INTERSEÇÃO entre as do ator e as das tools da allowlist do agente: nunca soma.

const { Company } = require('../../../models');
const { contextInvalid, serviceIdentityDisabled } = require('./toolSecurity.errors');
const repo = require('../serviceIdentities/serviceIdentities.repository');

const frozen = (lista) => Object.freeze([...(lista || [])]);

function buildUserContext(auth, { correlationId, runId } = {}) {
  if (!auth || !auth.userId || !auth.groupId || !auth.companyId) throw contextInvalid('Contexto de execução da NAY sem usuário ou empresa.');
  return Object.freeze({
    actor: Object.freeze({ type: 'USER', userId: auth.userId }),
    actorLabel: `user:${auth.userId}`,
    groupId: auth.groupId,
    companyId: auth.companyId,
    permissions: frozen(auth.permissions),
    roles: frozen(auth.roles),
    correlationId: correlationId || null,
    runId: runId || null,
  });
}

const serviceLabel = (agentCode, companyName) => `service:${agentCode}@${companyName}`;

/** Contexto de um job: a identidade de serviço ATIVA do agente na empresa, com as permissões fechadas de leitura dela. */
async function loadServiceContext(scope, agentCode, transaction, { correlationId, runId } = {}) {
  const identity = await repo.findEnabled(scope, agentCode, transaction);
  if (!identity) throw serviceIdentityDisabled();
  const company = await Company.findByPk(scope.companyId, { attributes: ['name'], transaction });
  const companyName = (company && company.name) || scope.companyId;
  return Object.freeze({
    actor: Object.freeze({ type: 'SERVICE', serviceIdentityId: identity.id }),
    actorLabel: serviceLabel(identity.agentCode, companyName),
    companyName,
    groupId: scope.groupId,
    companyId: scope.companyId,
    permissions: frozen(identity.permissions),
    roles: frozen([]),
    correlationId: correlationId || null,
    runId: runId || null,
  });
}

/** Permissão efetiva = (permissões do ator) ∩ (permissões das tools habilitadas da allowlist, lidas da definição do registro). */
function effectivePermissions(execCtx, agent, registry) {
  const declaradas = new Set();
  for (const entrada of (agent && agent.tools) || []) {
    const def = entrada.enabled ? registry.get(entrada.toolName) : undefined;
    if (def) declaradas.add(def.permissionCode);
  }
  return execCtx.permissions.filter((p) => declaradas.has(p));
}

module.exports = { buildUserContext, loadServiceContext, serviceLabel, effectivePermissions };
