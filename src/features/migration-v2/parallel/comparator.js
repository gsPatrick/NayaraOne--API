'use strict';

const { getTarget } = require('../ingest/targets');
const connectors = require('../ingest/connectors');
const { mapRow } = require('../ingest/row.canonical');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const refs = require('./refs.repository');
const errors = require('./parallel.errors');
const { compareField, hashOf, RESULT } = require('./compare.rule');

const tupleKey = (entity, sourceKey, field) => `${entity}\u0000${sourceKey}\u0000${field}`;

/** Resultado do registro inteiro (campo vazio): existe só de um lado. Sempre bloqueante (M9-D903 §3.5). */
const missing = (entity, sourceKey, kind) => ({ entity, sourceKey, field: '', result: RESULT.BLOCKER, kind, oldHash: null, newHash: null, persist: true });

function compareRecord(entity, sourceKey, oldCanonical, newCanonical, rules, ctx, openSet) {
  const out = [];
  for (const rule of rules) {
    const outcome = compareField(rule, oldCanonical[rule.field], newCanonical[rule.field], ctx);
    if (!outcome) continue;
    out.push({
      entity, sourceKey, field: rule.field, result: outcome.result, kind: outcome.result === RESULT.BLOCKER ? 'VALUE' : null,
      oldHash: hashOf(rule.field, outcome.oldNormalized), newHash: hashOf(rule.field, outcome.newNormalized),
      // MATCH só é gravado quando fecha uma diferença aberta; o resto do que bateu entra apenas na contagem da execução.
      persist: outcome.result !== RESULT.MATCH || openSet.has(tupleKey(entity, sourceKey, rule.field)),
    });
  }
  return out;
}

/** Linha da origem na forma canônica do destino (mesmo caminho do aplicador: columnMap e `canonical` do destino). Linha que não vira forma canônica = null. */
function oldCanonicalOf(target, source, record) {
  try {
    return target.canonical(mapRow(record, source.config && source.config.columnMap));
  } catch (err) {
    return null;
  }
}

/**
 * Compara uma entidade de uma fonte (M9-D903 §3.2 a §3.5): lê a origem por páginas em ordem de chave, pareia pela referência do ID legado, relê o destino pelo banco e aplica a
 * regra de cada campo. Devolve { rows, tally }: `rows` são as linhas a gravar (tudo que não bateu, e o MATCH que fecha diferença aberta); `tally` conta o resultado por campo.
 * A origem é lida pelo conector (somente leitura); falha ao abrir ou ler sobe para o chamador, que a trata como GOV_PARALLEL_SOURCE_DOWN.
 */
async function compareEntity({ tenant, source, rules, ctx, pageSize, openSet }) {
  const target = getTarget(source.entity);
  const entityRules = rules.filter((rule) => rule.entity === source.entity);
  const [currentRefs, deleted] = await openTenantTx(tenant, async (tx) => [
    await refs.currentRefs(tenant, source.source_system, source.entity, tx), await refs.deletedKeys(tenant, source.source_system, source.entity, tx),
  ]);
  const rows = [];
  const tally = { records: 0, fields: 0, MATCH: 0, DIFF_ALLOWED: 0, DIFF_BLOCKER: 0, MISSING_IN_NEW: 0, MISSING_IN_OLD: 0 };
  const seen = new Set();
  const down = (err) => errors.sourceDown({ source_system: source.source_system, entity: source.entity, reason: (err && err.code) || 'READ_FAILED' });
  const connector = await connectors.open(source).catch((err) => { throw down(err); });
  try {
    let after = '';
    for (;;) {
       
      const page = await connector.readAllRows({ afterKey: after, limit: pageSize }).catch((err) => { throw down(err); });
      if (!page.length) break;
      after = page[page.length - 1].sourceKey;
      const ids = page.map((item) => currentRefs.get(item.sourceKey)).filter(Boolean);
       
      const newSide = await openTenantTx(tenant, (tx) => target.readCanonical(tenant, ids, tx));
      for (const item of page) {
        seen.add(item.sourceKey);
        tally.records += 1;
        const entityId = currentRefs.get(item.sourceKey);
        const newCanonical = entityId ? newSide.get(entityId) : null;
        if (!newCanonical) {
          if (!deleted.has(item.sourceKey)) { rows.push(missing(source.entity, item.sourceKey, 'MISSING_IN_NEW')); tally.MISSING_IN_NEW += 1; }
          continue;
        }
        const oldCanonical = oldCanonicalOf(target, source, item.record);
        if (!oldCanonical) { rows.push(missing(source.entity, item.sourceKey, 'VALUE')); tally.DIFF_BLOCKER += 1; continue; }
        for (const row of compareRecord(source.entity, item.sourceKey, oldCanonical, newCanonical, entityRules, ctx, openSet)) {
          tally.fields += 1;
          tally[row.result] += 1;
          if (row.persist) rows.push(row);
        }
      }
    }
  } finally {
    await connector.close();
  }
  for (const key of currentRefs.keys()) {
    if (seen.has(key) || deleted.has(key)) continue;
    rows.push(missing(source.entity, key, 'MISSING_IN_OLD'));
    tally.MISSING_IN_OLD += 1;
  }
  return { rows, tally };
}

module.exports = { compareEntity, tupleKey };
