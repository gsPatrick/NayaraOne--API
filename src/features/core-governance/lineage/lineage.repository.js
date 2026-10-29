'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Acesso a governance.lineage_nodes, lineage_edges e lineage_seed_state (M9-D810). O registro é do GRUPO: a RLS isola pelo grupo da sessão e o filtro
 * explícito por `group_id` vale de qualquer forma.
 */
const NODE_COLUMNS = `n.id, n.node_type AS "nodeType", n.code, n.description, n.owner_domain AS "ownerDomain", n.criticality, n.area, n.source`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

async function findNode(groupId, nodeType, code, transaction, { lock = false } = {}) {
  const rows = await select(`SELECT ${NODE_COLUMNS} FROM governance.lineage_nodes n WHERE n.group_id = :groupId AND n.node_type = :nodeType AND n.code = :code${lock ? ' FOR UPDATE' : ''}`,
    { groupId, nodeType, code }, transaction);
  return rows[0] || null;
}

async function insertNode(groupId, actorUserId, node, transaction) {
  const rows = await select(
    `INSERT INTO governance.lineage_nodes (group_id, node_type, code, description, owner_domain, criticality, area, source, created_by, updated_by)
     VALUES (:groupId, :nodeType, :code, :description, :ownerDomain, :criticality, :area, 'API', :actorUserId, :actorUserId)
     ON CONFLICT (group_id, node_type, code) DO NOTHING
     RETURNING id`,
    { groupId, actorUserId: actorUserId || null, ...node }, transaction
  );
  return rows[0] || null;
}

async function updateNode(id, actorUserId, node, transaction) {
  await sequelize.query(
    `UPDATE governance.lineage_nodes SET description = :description, owner_domain = :ownerDomain, criticality = :criticality, area = :area, source = 'API',
            updated_by = :actorUserId, updated_at = now() WHERE id = :id`,
    { transaction, replacements: { id, actorUserId: actorUserId || null, ...node } }
  );
}

const EDGE_SELECT = `SELECT e.id, e.transformation, e.source, f.node_type AS "fromType", f.code AS "fromCode", t.node_type AS "toType", t.code AS "toCode", e.from_node_id AS "fromId", e.to_node_id AS "toId"
    FROM governance.lineage_edges e JOIN governance.lineage_nodes f ON f.id = e.from_node_id JOIN governance.lineage_nodes t ON t.id = e.to_node_id`;

async function findEdge(groupId, fromId, toId, transaction, { lock = false } = {}) {
  const rows = await select(`${EDGE_SELECT} WHERE e.group_id = :groupId AND e.from_node_id = :fromId AND e.to_node_id = :toId${lock ? ' FOR UPDATE OF e' : ''}`, { groupId, fromId, toId }, transaction);
  return rows[0] || null;
}

async function insertEdge(groupId, actorUserId, fromId, toId, transformation, transaction) {
  const rows = await select(
    `INSERT INTO governance.lineage_edges (group_id, from_node_id, to_node_id, transformation, source, created_by)
     VALUES (:groupId, :fromId, :toId, :transformation, 'API', :actorUserId) ON CONFLICT (group_id, from_node_id, to_node_id) DO NOTHING RETURNING id`,
    { groupId, fromId, toId, transformation, actorUserId: actorUserId || null }, transaction
  );
  return rows[0] || null;
}

async function updateEdge(id, transformation, transaction) {
  await sequelize.query("UPDATE governance.lineage_edges SET transformation = :transformation, source = 'API' WHERE id = :id", { transaction, replacements: { id, transformation } });
}

/** Todos os nós e arestas do grupo (`onlySeed` = só o que veio das sementes). */
async function loadAll(groupId, transaction, { onlySeed = false } = {}) {
  const filter = onlySeed ? " AND n.source = 'SEED'" : '';
  const nodes = await select(`SELECT ${NODE_COLUMNS} FROM governance.lineage_nodes n WHERE n.group_id = :groupId${filter} ORDER BY n.node_type, n.code`, { groupId }, transaction);
  const edges = await select(`${EDGE_SELECT} WHERE e.group_id = :groupId${onlySeed ? " AND e.source = 'SEED'" : ''} ORDER BY f.node_type, f.code, t.node_type, t.code`, { groupId }, transaction);
  return { nodes, edges };
}

async function getSeedHash(groupId, transaction) {
  const rows = await select('SELECT seed_hash AS "seedHash" FROM governance.lineage_seed_state WHERE group_id = :groupId', { groupId }, transaction);
  return rows[0] ? rows[0].seedHash : null;
}

async function setSeedHash(groupId, seedHash, transaction) {
  await sequelize.query(
    `INSERT INTO governance.lineage_seed_state (group_id, seed_hash, applied_at) VALUES (:groupId, :seedHash, now())
     ON CONFLICT (group_id) DO UPDATE SET seed_hash = EXCLUDED.seed_hash, applied_at = now()`,
    { transaction, replacements: { groupId, seedHash } }
  );
}

/** Semeia nós em lote (colunas em arrays): atualiza só o que ainda é da semente, nunca o que a área editou pela API. */
async function upsertSeedNodes(groupId, nodes, transaction) {
  if (!nodes.length) return;
  await sequelize.query(
    `INSERT INTO governance.lineage_nodes (group_id, node_type, code, description, owner_domain, criticality, area, source)
     SELECT $1::uuid, x.node_type, x.code, x.description, x.owner_domain, x.criticality, x.area, 'SEED'
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS x(node_type, code, description, owner_domain, criticality, area)
     ON CONFLICT (group_id, node_type, code) DO UPDATE SET description = EXCLUDED.description, owner_domain = EXCLUDED.owner_domain,
       criticality = EXCLUDED.criticality, area = EXCLUDED.area, updated_at = now()
     WHERE governance.lineage_nodes.source = 'SEED'`,
    { transaction, bind: [groupId, nodes.map((n) => n.nodeType), nodes.map((n) => n.code), nodes.map((n) => n.description), nodes.map((n) => n.ownerDomain), nodes.map((n) => n.criticality), nodes.map((n) => n.area)] }
  );
}

async function upsertSeedEdges(groupId, edges, transaction) {
  if (!edges.length) return;
  await sequelize.query(
    `INSERT INTO governance.lineage_edges (group_id, from_node_id, to_node_id, transformation, source)
     SELECT $1::uuid, f.id, t.id, x.transformation, 'SEED'
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(from_type, from_code, to_type, to_code, transformation)
       JOIN governance.lineage_nodes f ON f.group_id = $1::uuid AND f.node_type = x.from_type AND f.code = x.from_code
       JOIN governance.lineage_nodes t ON t.group_id = $1::uuid AND t.node_type = x.to_type AND t.code = x.to_code
     ON CONFLICT (group_id, from_node_id, to_node_id) DO UPDATE SET transformation = EXCLUDED.transformation WHERE governance.lineage_edges.source = 'SEED'`,
    { transaction, bind: [groupId, edges.map((e) => e.from.nodeType), edges.map((e) => e.from.code), edges.map((e) => e.to.nodeType), edges.map((e) => e.to.code), edges.map((e) => e.transformation || '')] }
  );
}

module.exports = { findNode, insertNode, updateNode, findEdge, insertEdge, updateEdge, loadAll, getSeedHash, setSeedHash, upsertSeedNodes, upsertSeedEdges };
