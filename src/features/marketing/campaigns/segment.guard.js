'use strict';

const { mktError } = require('../marketing.errors');
const { readForbiddenSegmentFields } = require('./segment.settings');

/**
 * M9-D419 regra 3 — dado sensível não serve como critério de segmentação. Antes de qualquer outra validação do público, toda chave do
 * filtro (em QUALQUER nível, dentro de objetos e listas, em qualquer tipo de público) é comparada com a lista fechada do parâmetro
 * `marketing.segment.campos_proibidos`: renda_exata, cpf, saude... Achou: 422 MKT_SEGMENT_SENSITIVE_FIELD, nada é gravado. A
 * comparação ignora caixa, acento e a forma (rendaExata, renda-exata e RENDA_EXATA são o mesmo campo). Filtros no formato
 * { campo: 'cpf' } também são pegos: o valor de uma chave que NOMEIA um campo é comparado do mesmo jeito.
 */
const FIELD_NAMING_KEYS = new Set(['campo', 'field', 'atributo', 'attribute', 'criterio', 'criteria', 'coluna', 'column', 'propriedade', 'property']);

function normalize(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function collect(node, path, forbidden, hits) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collect(item, `${path}[${i}]`, forbidden, hits));
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const here = path ? `${path}.${key}` : key;
      if (forbidden.has(normalize(key))) hits.push(here);
      const value = node[key];
      if (FIELD_NAMING_KEYS.has(normalize(key)) && typeof value === 'string' && forbidden.has(normalize(value))) hits.push(`${here}=${value}`);
      collect(value, here, forbidden, hits);
    }
  }
}

/** Campos proibidos achados no filtro (caminhos), ou []. */
function findSensitiveFields(filter, forbiddenList) {
  const hits = [];
  collect(filter, '', new Set(forbiddenList.map(normalize)), hits);
  return hits;
}

/** `audiences` como veio no corpo da requisição. Lança 422 se algum filtro usa dado sensível. */
async function assertSegmentsNotSensitive(audiences, tenant, transaction) {
  if (!Array.isArray(audiences)) return;
  const forbidden = await readForbiddenSegmentFields(tenant, transaction);
  const fields = [];
  audiences.forEach((audience, index) => {
    if (audience && typeof audience === 'object') findSensitiveFields(audience.filter, forbidden).forEach((hit) => fields.push(`audiences[${index}].filter.${hit}`));
  });
  if (fields.length > 0) throw mktError(422, 'MKT_SEGMENT_SENSITIVE_FIELD', 'Este critério de segmentação usa dado sensível e não é permitido.', { fields });
}

module.exports = { assertSegmentsNotSensitive, findSensitiveFields, normalize };
