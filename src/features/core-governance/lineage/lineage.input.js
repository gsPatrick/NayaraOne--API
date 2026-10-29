'use strict';

const errors = require('./lineage.errors');
const rules = require('./lineage.rules');
const { CODE_PATTERN, blank } = require('./lineage.constants');

const pick = (body, ...names) => { for (const name of names) if (body && body[name] !== undefined) return body[name]; return undefined; };
const text = (value) => (typeof value === 'string' ? value.trim() : value);

/** Referência a um nó numa aresta: { nodeType|node_type, code }. */
function parseRef(raw) {
  const nodeType = text(pick(raw, 'nodeType', 'node_type'));
  const code = text(raw && raw.code);
  rules.assertNodeType(nodeType);
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw errors.codeInvalid();
  return { nodeType, code };
}

/**
 * Corpo de nó (camelCase ou snake_case). Valida na ordem: tipo, código, responsável (422), descrição (422), área (422/400) e criticidade (409 se rebaixar
 * área obrigatória). `ownerDomain` é conferido contra os domínios da empresa pelo serviço (precisa do parâmetro).
 */
function parseNode(body) {
  const nodeType = text(pick(body, 'nodeType', 'node_type'));
  const code = text(pick(body, 'code'));
  rules.assertNodeType(nodeType);
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw errors.codeInvalid();
  const ownerDomain = text(pick(body, 'ownerDomain', 'owner_domain'));
  if (blank(ownerDomain)) throw errors.ownerRequired();
  const description = text(pick(body, 'description'));
  if (blank(description)) throw errors.descriptionRequired();
  const area = text(pick(body, 'area'));
  if (blank(area)) throw errors.areaRequired();
  rules.assertArea(area);
  const criticality = rules.resolveCriticality(area, text(pick(body, 'criticality')));
  return { nodeType, code, description: description.slice(0, 1000), ownerDomain: ownerDomain.toUpperCase(), criticality, area };
}

/** Corpo de aresta: from_node/to_node (ou from/to) e transformation (texto curto, opcional). */
function parseEdge(body) {
  const from = parseRef(pick(body, 'from_node', 'fromNode', 'from'));
  const to = parseRef(pick(body, 'to_node', 'toNode', 'to'));
  rules.assertEdgeLayers(from.nodeType, to.nodeType);
  const transformation = text(pick(body, 'transformation'));
  return { from, to, transformation: typeof transformation === 'string' && transformation ? transformation.slice(0, 200) : null };
}

module.exports = { parseNode, parseEdge, parseRef };
