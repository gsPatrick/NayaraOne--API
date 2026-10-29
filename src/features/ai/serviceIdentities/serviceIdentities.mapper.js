'use strict';

const { serviceLabel } = require('../orchestrator/executionContext');

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Visão da API: o nome que aparece nos logs é `service:<AGENTE>@<empresa>`. */
function toIdentity(model, companyName) {
  const k = model.get({ plain: true });
  return {
    id: k.id, companyId: k.companyId, agentCode: k.agentCode, permissions: [...k.permissions], enabled: k.enabled,
    displayName: serviceLabel(k.agentCode, companyName), createdBy: k.createdBy, createdAt: iso(k.createdAt), updatedAt: iso(k.updatedAt),
  };
}

/** Trilha de auditoria: o que muda a identidade (agente, permissões, estado). */
const auditSnapshot = (i) => ({ agentCode: i.agentCode, permissions: i.permissions, enabled: i.enabled });

module.exports = { toIdentity, auditSnapshot };
