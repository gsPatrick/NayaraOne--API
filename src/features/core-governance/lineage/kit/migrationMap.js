'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ENTITY_DOMAIN } = require('./migrationCatalog');

/** Mapa de campos da migração (M9-D914 §3.4): `docs/governance/migration-field-map.json`, lista de { entity, sourceSystem, sourceField, domainField, critical }, uma linha por campo. */
const MAP_FILE = path.resolve(__dirname, '../../../../../docs/governance/migration-field-map.json');
const SYSTEM = /^[A-Z][A-Z0-9_]{1,39}$/;
const SOURCE_FIELD = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/; // <tabela>.<coluna> do legado
const DOMAIN_FIELD = /^[a-z_]+\.[A-Za-z_]+\.[A-Za-z0-9_]+$/; // <schema>.<Entidade ou tabela>.<atributo>

/** Motivo (texto) de uma linha inválida, ou null. */
function rowProblem(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'a linha não é um objeto';
  if (!Object.prototype.hasOwnProperty.call(ENTITY_DOMAIN, row.entity)) return `entidade desconhecida: ${row.entity}`;
  if (!SYSTEM.test(String(row.sourceSystem))) return 'sourceSystem inválido';
  if (!SOURCE_FIELD.test(String(row.sourceField))) return `sourceField deve ser <tabela>.<coluna>: ${row.sourceField}`;
  if (!DOMAIN_FIELD.test(String(row.domainField))) return `domainField inválido: ${row.domainField}`;
  if (typeof row.critical !== 'boolean') return 'critical deve ser verdadeiro ou falso';
  return null;
}

/** Código do nó de origem: `<sistema>.<tabela>.<coluna>`. Mesma regra do portão (M9-D811). */
const sourceCode = (row) => (String(row.sourceField).startsWith(`${row.sourceSystem}.`) ? String(row.sourceField) : `${row.sourceSystem}.${row.sourceField}`);

/** Lê e valida o mapa. Arquivo ausente ou linha inválida falha fechado (o gerador não escreve registro pela metade). */
function loadMap(file = MAP_FILE) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`Mapa de campos da migração ilegível (${path.basename(file)}): ${err.message}`); }
  if (!Array.isArray(rows)) throw new Error('Mapa de campos da migração: o arquivo deve ser uma lista.');
  const seen = new Set();
  rows.forEach((row, index) => {
    const problem = rowProblem(row);
    if (problem) throw new Error(`Mapa de campos da migração, linha ${index + 1}: ${problem}.`);
    const key = `${sourceCode(row)}>${row.domainField}`;
    if (seen.has(key)) throw new Error(`Mapa de campos da migração, linha ${index + 1}: campo repetido ${key}.`);
    seen.add(key);
  });
  return rows;
}

module.exports = { MAP_FILE, loadMap, rowProblem, sourceCode };
