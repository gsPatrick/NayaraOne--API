'use strict';

const { normalizeKey } = require('./view.fields');
const { maskValue } = require('./view.mask');

/**
 * Varredura do corpo JSON de uma resposta (M9-D825 §3.1): para cada campo sensível presente (chave do registro) anota a classe e o recurso a que pertence (o `id` do
 * objeto mais próximo, ou o da raiz). `fields` = { chaveNormalizada: 'HIGH'|'RESTRICTED' }. Funções puras; o corpo recebido já é uma cópia própria.
 */
const isObject = (value) => value !== null && typeof value === 'object';
const presentValue = (value) => value !== null && value !== undefined && value !== '';

function walk(node, fields, visit, currentId) {
  if (Array.isArray(node)) { for (const item of node) walk(item, fields, visit, currentId); return; }
  if (!isObject(node)) return;
  const id = typeof node.id === 'string' || typeof node.id === 'number' ? String(node.id) : currentId;
  for (const [key, value] of Object.entries(node)) {
    const classification = fields[normalizeKey(key)];
    if (classification && presentValue(value)) visit(node, key, classification, id);
    else if (isObject(value)) walk(value, fields, visit, id);
  }
}

/** { HIGH: { ids: [..], hits: n }, RESTRICTED: {...} } só com as classes presentes. */
function collect(body, fields) {
  const found = {};
  walk(body, fields, (_node, _key, classification, id) => {
    found[classification] = found[classification] || { ids: new Set(), hits: 0 };
    found[classification].hits += 1;
    if (id) found[classification].ids.add(id);
  }, null);
  return Object.fromEntries(Object.entries(found).map(([classification, info]) => [classification, { ids: [...info.ids], hits: info.hits }]));
}

/** Mascara no próprio corpo os campos das classes pedidas (`classes`: lista); `full` = máscara total (falha da política). Devolve quantos valores mascarou. */
function applyMask(body, fields, classes, { keep, full }) {
  let masked = 0;
  walk(body, fields, (node, key, classification) => {
    if (!classes.includes(classification)) return;
    node[key] = maskValue(node[key], { keep, full });
    masked += 1;
  }, null);
  return masked;
}

module.exports = { collect, applyMask };
