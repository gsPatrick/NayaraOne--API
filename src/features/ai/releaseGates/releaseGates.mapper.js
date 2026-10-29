'use strict';

const toGate = (r) => ({
  id: r.id, level: r.companyId ? 'COMPANY' : 'GROUP', companyId: r.companyId, scopeType: r.scopeType, scopeRef: r.scopeRef, item: r.item, status: r.status,
  evidenceRef: r.evidenceRef, approvedBy: r.approvedBy, approvedAt: r.approvedAt, notes: r.notes, registeredBy: r.registeredBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/** Auditoria: o que a aprovação diz, sem texto livre (notas) nem referência de evidência. */
const auditSnapshot = (r) => ({ id: r.id, level: r.companyId ? 'COMPANY' : 'GROUP', item: r.item, scopeRef: r.scopeRef, status: r.status, approvedBy: r.approvedBy, approvedAt: r.approvedAt, registeredBy: r.registeredBy });

module.exports = { toGate, auditSnapshot };
