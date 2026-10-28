'use strict';

/**
 * M9-D604 (3.1) — o que é "mudança de fórmula": qualquer alteração nestes campos exige nova versão. Aqui ficam a lista, a leitura
 * dos campos de uma linha de metric_versions e a diferença campo a campo (usada na auditoria e na recusa de edição direta).
 */
const { canonical } = require('./formulaCatalog');

// chave de entrada -> coluna de metric_versions
const VERSIONED_FIELDS = Object.freeze({
  formulaId: 'formula_id', formulaSemantic: 'formula_semantic', sourceReadModel: 'source_read_model', dimensions: 'dimensions',
  filters: 'filters', unit: 'unit', qualityRule: 'quality_rule', valueNature: 'value_nature', refreshPolicy: 'refresh_policy',
  formulaParams: 'formula_params',
});

/** Campos versionados de uma linha de metric_versions, com as chaves de entrada. */
function versionFields(row) {
  const out = {};
  for (const [key, column] of Object.entries(VERSIONED_FIELDS)) out[key] = row[column] === undefined ? null : row[column];
  return out;
}

/** { campo: { before, after } } só dos campos cujo valor mudou (comparação canônica, ordem de chaves não importa). */
function diffFields(before, after) {
  const changes = {};
  for (const key of Object.keys(VERSIONED_FIELDS)) {
    if (canonical(before[key]) !== canonical(after[key])) changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return changes;
}

module.exports = { VERSIONED_FIELDS, versionFields, diffFields };
