'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { isModuleEnabled } = require('../governance.module');
const dataQuality = require('../data-quality/data-quality.settings');
const settings = require('./lineage.settings');
const errors = require('./lineage.errors');
const repository = require('./lineage.repository');
const { parseNode, parseEdge } = require('./lineage.input');
const { computeCoverage } = require('./lineage.coverage');
const { catalogEntries, applyCriticalKpiList, scopeRegistry } = require('./lineage.catalog');
const { ensureSeeded } = require('./lineage.seed');
const { MANDATORY_AREAS } = require('./lineage.constants');

const NODE_ENTITY = 'governance.lineage_node';
const EDGE_ENTITY = 'governance.lineage_edge';

const nodeView = (row) => ({ id: row.id, nodeType: row.nodeType, code: row.code, description: row.description, ownerDomain: row.ownerDomain, criticality: row.criticality, area: row.area, source: row.source });
const sameNode = (a, b) => ['description', 'ownerDomain', 'criticality', 'area'].every((field) => a[field] === b[field]);
const edgeView = (row) => ({ id: row.id, from: { nodeType: row.fromType, code: row.fromCode }, to: { nodeType: row.toType, code: row.toCode }, transformation: row.transformation, source: row.source });

/** Domínios aceitos como responsável: os de dados mestres da empresa (D804) mais os adicionais do lineage. */
async function allowedDomains(tenant, transaction) {
  const base = dataQuality.parseDomains(await getSetting(dataQuality.DOMAINS_KEY, tenant, transaction, dataQuality.DEFAULT_DOMAINS));
  const extra = settings.parseExtraDomains(await getSetting(settings.EXTRA_DOMAINS_KEY, tenant, transaction, settings.LINEAGE_SETTING_DEFAULTS[settings.EXTRA_DOMAINS_KEY]));
  return [...new Set([...base, ...extra])];
}

async function audit(tenant, actor, action, entityType, entityId, beforeJson, afterJson, reason, transaction) {
  await registrarAuditoria({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action, entityType, entityId, beforeJson, afterJson, reason }, transaction);
}

/**
 * POST (create) e PUT (upsert por tipo + código) de nó (M9-D810 §3.4). A linha é travada antes de decidir; repetir o mesmo conteúdo não grava nem audita.
 * Área obrigatória nunca perde a criticidade, nem trocando a área do nó para fora das obrigatórias (409).
 */
async function saveNode(tenant, actor, body, transaction, { create = false } = {}) {
  const node = parseNode(body);
  if (!(await allowedDomains(tenant, transaction)).includes(node.ownerDomain)) throw errors.domainInvalid();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await repository.findNode(tenant.groupId, node.nodeType, node.code, transaction, { lock: true });
    if (existing) {
      if (create) throw errors.nodeExists();
      if (MANDATORY_AREAS.includes(existing.area) && !MANDATORY_AREAS.includes(node.area)) throw errors.criticalityLocked();
      if (sameNode(existing, node)) return nodeView(existing);
      await repository.updateNode(existing.id, actor.userId, node, transaction);
      const after = nodeView({ ...existing, ...node, source: 'API' });
      await audit(tenant, actor, `${NODE_ENTITY}.updated`, NODE_ENTITY, existing.id, nodeView(existing), after, `Nó de lineage ${node.code} atualizado.`, transaction);
      return after;
    }
    const inserted = await repository.insertNode(tenant.groupId, actor.userId, node, transaction);
    if (inserted) {
      const after = nodeView({ id: inserted.id, ...node, source: 'API' });
      await audit(tenant, actor, `${NODE_ENTITY}.created`, NODE_ENTITY, inserted.id, null, after, `Nó de lineage ${node.code} criado.`, transaction);
      return after;
    }
  }
  throw errors.nodeExists();
}

async function resolveEndpoint(tenant, ref, transaction) {
  const node = await repository.findNode(tenant.groupId, ref.nodeType, ref.code, transaction);
  if (!node) throw errors.nodeNotFound();
  return node;
}

/** POST (create) e PUT (upsert por par de nós) de aresta: valida as camadas e os dois nós na mesma transação da gravação. */
async function saveEdge(tenant, actor, body, transaction, { create = false } = {}) {
  const edge = parseEdge(body);
  const from = await resolveEndpoint(tenant, edge.from, transaction);
  const to = await resolveEndpoint(tenant, edge.to, transaction);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await repository.findEdge(tenant.groupId, from.id, to.id, transaction, { lock: true });
    if (existing) {
      if (create) throw errors.edgeExists();
      if ((existing.transformation || null) === edge.transformation) return edgeView(existing);
      await repository.updateEdge(existing.id, edge.transformation, transaction);
      const after = edgeView({ ...existing, transformation: edge.transformation, source: 'API' });
      await audit(tenant, actor, `${EDGE_ENTITY}.updated`, EDGE_ENTITY, existing.id, edgeView(existing), after, 'Ligação de lineage atualizada.', transaction);
      return after;
    }
    const inserted = await repository.insertEdge(tenant.groupId, actor.userId, from.id, to.id, edge.transformation, transaction);
    if (inserted) {
      const after = { id: inserted.id, from: edge.from, to: edge.to, transformation: edge.transformation, source: 'API' };
      await audit(tenant, actor, `${EDGE_ENTITY}.created`, EDGE_ENTITY, inserted.id, null, after, 'Ligação de lineage criada.', transaction);
      return after;
    }
  }
  throw errors.edgeExists();
}

/** Registro do grupo no formato do cálculo de cobertura. */
async function loadRegistry(tenant, transaction) {
  const { nodes, edges } = await repository.loadAll(tenant.groupId, transaction);
  return { nodes: nodes.map(nodeView), edges: edges.map(edgeView) };
}

/** GET /data-lineage: estado do módulo e a cobertura crítica do grupo (a semente é aplicada na primeira leitura). */
async function getOverview(tenant, transaction) {
  await ensureSeeded(tenant, transaction);
  const registry = await loadRegistry(tenant, transaction);
  const list = settings.parseCriticalKpis(await getSetting(settings.CRITICAL_KPIS_KEY, tenant, transaction, settings.LINEAGE_SETTING_DEFAULTS[settings.CRITICAL_KPIS_KEY]));
  const { critical, covered, uncovered, percent } = computeCoverage(scopeRegistry(registry, list), applyCriticalKpiList(catalogEntries(), list));
  return {
    modulo: 'lineage', rotulo: 'Linhagem de dados', habilitado: await isModuleEnabled('lineage', tenant, transaction),
    cobertura: { critical, covered, uncovered, percent }, itens: { nos: registry.nodes.length, arestas: registry.edges.length },
  };
}

module.exports = { saveNode, saveEdge, loadRegistry, getOverview, allowedDomains };
