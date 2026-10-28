'use strict';

/** Instância do modelo -> objeto da API. `systemPolicy` sai por padrão; `withoutPolicy` o tira para quem só usa a NAY. */
function toAgent(model, tools = []) {
  const a = model.get({ plain: true });
  return {
    id: a.id,
    groupId: a.groupId,
    companyId: a.companyId,
    scope: a.companyId ? 'COMPANY' : 'SYSTEM',
    code: a.code,
    version: a.version,
    status: a.status,
    purpose: a.purpose,
    systemPolicy: a.systemPolicy,
    modelPolicy: a.modelPolicy,
    permissions: a.permissions,
    dataScopes: a.dataScopes,
    limits: a.limits,
    criticality: a.criticality,
    enabled: a.enabled,
    configHash: a.configHash,
    createdFromVersion: a.createdFromVersion,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    homologatedBy: a.homologatedBy,
    homologatedAt: a.homologatedAt,
    homologationNote: a.homologationNote,
    activatedBy: a.activatedBy,
    activatedAt: a.activatedAt,
    retiredBy: a.retiredBy,
    retiredAt: a.retiredAt,
    tools,
  };
}

function toTool(model) {
  const t = model.get({ plain: true });
  return {
    toolName: t.toolName,
    permissionCode: t.permissionCode,
    riskLevel: t.riskLevel,
    requiresHumanApproval: t.requiresHumanApproval,
    enabled: t.enabled,
  };
}

function withoutPolicy(agent) {
  const { systemPolicy, ...rest } = agent;
  return rest;
}

/** Retrato curto para a trilha de auditoria: sem o texto da política (só o hash dela). */
function auditSnapshot(agent) {
  return {
    code: agent.code, version: agent.version, status: agent.status, enabled: agent.enabled, purpose: agent.purpose,
    criticality: agent.criticality, configHash: agent.configHash, tools: (agent.tools || []).map((t) => t.toolName),
    homologatedBy: agent.homologatedBy, activatedBy: agent.activatedBy,
  };
}

module.exports = { toAgent, toTool, withoutPolicy, auditSnapshot };
