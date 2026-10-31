'use strict';

const fieldAccess = require('../../core-governance/data-quality/fieldAccess.service');

// Tabela do registro de classificação (M9-D910) onde cada entidade migrada é gravada: é por ela que a máscara da M9-D915 decide o que se mostra.
const DISPLAY_TABLE = Object.freeze({ PERSON: 'people.persons', SUPPLIER: 'people.persons', PROPERTY: 'property.properties' });
const IDENTITY_FIELDS = Object.freeze({ PERSON: ['legalName', 'taxId'], SUPPLIER: ['legalName', 'taxId'], PROPERTY: ['title', 'addressLine'] });

/**
 * Exemplos para EXIBIR no relatório do ensaio (M9-D908 §3.3.1). Com `clearPii` desligado (o padrão) cada valor passa pela máscara do registro de classificação (M9-D915, contexto
 * LOG: campo HIGH ou RESTRICTED sai sempre mascarado, sem consultar permissão de quem lê). A máscara vale só aqui: o hash do lote (D905) e a comparação paralela (D903) leem o valor real dentro do processo, antes de qualquer máscara.
 */
async function displaySamples(tenant, actor, sampled, { clearPii, limit }) {
  const out = [];
  for (const sample of sampled) {
    for (const item of sample.items) {
      if (out.length >= limit) return out;
      const table = DISPLAY_TABLE[sample.entity];
      const identity = (IDENTITY_FIELDS[sample.entity] || []).filter((field) => item.canonical && item.canonical[field] !== undefined);
      const shown = [
        ...identity.map((field) => ({ field, value: item.canonical[field] })),
        ...item.fields.flatMap((field) => [{ field: `${field.field}:origem`, base: field.field, value: field.source }, { field: `${field.field}:destino`, base: field.field, value: field.destination }]),
      ];
      let fields = shown.map((entry) => ({ field: entry.field, value: entry.value }));
      if (!clearPii && table) {
        const resolved = await fieldAccess.resolveFields(table, shown.map((entry) => ({ field: entry.base || entry.field, value: entry.value })), actor, 'LOG', {});
        fields = shown.map((entry, index) => ({ field: entry.field, value: resolved[index].visible ? resolved[index].maskedValue : null }));
      }
      out.push({ entity: sample.entity, sourceKey: item.sourceKey, masked: !clearPii, fields });
    }
  }
  return out;
}

module.exports = { displaySamples, DISPLAY_TABLE };
