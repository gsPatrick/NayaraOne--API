'use strict';

const { getTarget } = require('../ingest/targets');
const connectors = require('../ingest/connectors');
const { mapRow } = require('../ingest/row.canonical');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const errors = require('./parallel.errors');
const refs = require('./refs.repository');
const runs = require('./run.repository');
const results = require('./results.repository');
const { getWindow, view } = require('./window.service');

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 500;
const RUNS_SHOWN = 20;

/** Valores atuais de cada chave pedida na origem (uma passada pelas páginas) e no destino. Quem chama tem a permissão da migração: o claro sai recalculado aqui, nunca do banco. */
async function liveValues(tenant, window, entity, keys, pageSize, transaction) {
  const source = await refs.sourceFor(tenant, window.source_system, entity, transaction);
  const out = new Map();
  if (!source) return out;
  const target = getTarget(entity);
  const wanted = new Set(keys);
  const oldSide = new Map();
  const connector = await connectors.open(source).catch(() => { throw errors.sourceDown({ source_system: source.source_system, entity }); });
  try {
    let after = '';
    while (oldSide.size < wanted.size) {
       
      const page = await connector.readAllRows({ afterKey: after, limit: pageSize }).catch(() => { throw errors.sourceDown({ source_system: source.source_system, entity }); });
      if (!page.length) break;
      after = page[page.length - 1].sourceKey;
      for (const item of page) if (wanted.has(item.sourceKey)) oldSide.set(item.sourceKey, item.record);
    }
  } finally {
    await connector.close();
  }
  const currentRefs = await openTenantTx(tenant, (tx) => refs.currentRefs(tenant, window.source_system, entity, tx));
  const ids = keys.map((key) => currentRefs.get(key)).filter(Boolean);
  const newSide = await openTenantTx(tenant, (tx) => target.readCanonical(tenant, ids, tx));
  for (const key of keys) {
    let oldCanonical = null;
    try { oldCanonical = oldSide.has(key) ? target.canonical(mapRow(oldSide.get(key), source.config && source.config.columnMap)) : null; } catch (err) { oldCanonical = null; }
    out.set(key, { old: oldCanonical, new: currentRefs.has(key) ? newSide.get(currentRefs.get(key)) || null : null });
  }
  return out;
}

/**
 * GET /migration/parallel/windows/:id (M9-D903 §3.4): a janela, suas regras, as últimas execuções e as diferenças bloqueantes em aberto. Os valores em claro são RECALCULADOS na
 * hora a partir da origem e do destino (o banco só guarda hash); a máscara de exibição é da M9-D915. `limit` corta a lista de diferenças (padrão 100, máximo 500).
 */
async function windowReport(tenant, id, { limit } = {}, transaction) {
  const { row, rules } = await getWindow(tenant, id, transaction);
  const cap = Math.min(Math.max(Number.parseInt(limit, 10) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const open = await results.openBlockers(tenant, id, transaction);
  const shown = open.slice(0, cap);
  const history = await runs.list(tenant, id, RUNS_SHOWN, transaction);
  const byEntity = new Map();
  for (const diff of shown) byEntity.set(diff.entity, [...(byEntity.get(diff.entity) || []), diff.source_key]);
  const pageSize = 2000;
  const live = new Map();
  for (const [entity, keys] of byEntity) {
     
    live.set(entity, await liveValues(tenant, row, entity, [...new Set(keys)], pageSize, transaction));
  }
  return {
    ...view(row, rules),
    runs: history.map((run) => ({ runNumber: run.run_number, status: run.status, errorCode: run.error_code, startedAt: run.started_at, finishedAt: run.finished_at, summary: run.summary })),
    openBlockers: { total: open.length, shown: shown.length },
    diffs: shown.map((diff) => {
      const values = (live.get(diff.entity) || new Map()).get(diff.source_key) || {};
      const field = diff.field || null;
      return {
        entity: diff.entity, sourceKey: diff.source_key, field, kind: diff.diff_kind, sinceRun: diff.run_number,
        oldValue: field && values.old ? values.old[field] ?? null : null, newValue: field && values.new ? values.new[field] ?? null : null,
      };
    }),
  };
}

module.exports = { windowReport };
