'use strict';

const { getTarget } = require('../ingest/targets');
const connectors = require('../ingest/connectors');
const { mapRow } = require('../ingest/row.canonical');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { loadSchema } = require('../integrity/schema.repository');
const refs = require('../parallel/refs.repository');
const { civilDay, instantOf } = require('./timezone.normalize');

const PAGE = 500;
const asText = (value) => (value instanceof Date ? value.toISOString() : String(value));
const TEMPORAL = ['date', 'instant'];

/** Valor de borda (M9-D908 §3.2.3): meia-noite, 23:59:59, 29/02 ou 31/12. */
function isEdge(value) {
  if (value === null || value === undefined || value === '') return false;
  const text = asText(value);
  return /(^|[^0-9])(00:00(:00)?|23:59:59)/.test(text) || /-02-29/.test(text) || /-12-31/.test(text);
}

/** A origem na forma esperada do destino: dia civil para `date`, UTC para `instant`. Horário que a migração põe em quarentena devolve { quarantined: código }. */
function expectedOf(def, value, options) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (def.type === 'date') return { value: civilDay(value) };
  const result = instantOf(value, def.field, options);
  return result.problem ? { quarantined: result.problem.code } : { value: result.value };
}

/**
 * Amostra de datas de borda de UMA fonte (M9-D908 §3.2.3): lê a origem inteira por páginas, escolhe até `limit` registros (os de borda primeiro, depois os demais) e compara, campo a
 * campo, o que a origem manda com o que o destino gravou. Os valores comparados são os REAIS dentro do processo; nada é mascarado aqui. Devolve { entity, fields, sampled, edge,
 * checked, divergences[], quarantined, items[] } (cada item traz as chaves e os valores para a exibição, que a máscara trata depois).
 */
async function sampleSource({ tenant, source, options, limit }) {
  const target = getTarget(source.entity);
  const schema = await openTenantTx(tenant, (transaction) => loadSchema(tenant, source.entity, transaction));
  const temporal = schema.filter((def) => TEMPORAL.includes(def.type));
  const out = { entity: source.entity, sourceSystem: source.source_system, fields: temporal.map((def) => def.field), sampled: 0, edge: 0, checked: 0, divergences: [], quarantined: 0, items: [] };
  if (!temporal.length) return out;
  const columnMap = source.config && source.config.columnMap;
  const edgeRows = [];
  const otherRows = [];
  const connector = await connectors.open(source);
  try {
    let after = '';
    for (;;) {
       
      const page = await connector.readAllRows({ afterKey: after, limit: PAGE });
      if (!page.length) break;
      after = page[page.length - 1].sourceKey;
      for (const item of page) {
        let canonical = null;
        try { canonical = target.canonical(mapRow(item.record, columnMap)); } catch (err) { canonical = null; }
        if (!canonical) continue;
        const isEdgeRow = temporal.some((def) => isEdge(canonical[def.field]));
        if (isEdgeRow) edgeRows.push({ sourceKey: item.sourceKey, canonical }); else if (edgeRows.length + otherRows.length < limit) otherRows.push({ sourceKey: item.sourceKey, canonical });
      }
    }
  } finally {
    await connector.close();
  }
  const chosen = [...edgeRows, ...otherRows].slice(0, limit);
  out.sampled = chosen.length;
  out.edge = Math.min(edgeRows.length, limit);
  const currentRefs = await openTenantTx(tenant, (transaction) => refs.currentRefs(tenant, source.source_system, source.entity, transaction));
  const ids = chosen.map((row) => currentRefs.get(row.sourceKey)).filter(Boolean);
  const destination = await openTenantTx(tenant, (transaction) => target.readCanonical(tenant, ids, transaction));
  for (const row of chosen) {
    const entityId = currentRefs.get(row.sourceKey);
    const actual = entityId ? destination.get(entityId) : null;
    const checks = temporal.map((def) => ({ def, expected: expectedOf(def, row.canonical[def.field], options) }));
    if (checks.some((check) => check.expected.quarantined)) { out.quarantined += 1; continue; } // a migração recusou o horário: está em quarentena, não no destino
    if (!actual) continue; // sem registro no destino (quarentena por outro motivo, revisão ou excluído): o volume e a Torre já o cobrem
    out.checked += 1;
    const fields = checks.map(({ def, expected }) => ({ field: def.field, source: row.canonical[def.field] === undefined ? null : row.canonical[def.field], expected: expected.value, destination: actual[def.field] === undefined ? null : actual[def.field] }));
    const wrong = fields.filter((field) => String(field.expected === null ? '' : field.expected) !== String(field.destination === null ? '' : field.destination));
    if (wrong.length) out.divergences.push({ sourceKey: row.sourceKey, fields: wrong });
    out.items.push({ sourceKey: row.sourceKey, canonical: row.canonical, fields });
  }
  return out;
}

module.exports = { sampleSource, isEdge, expectedOf };
