'use strict';

const { randomUUID } = require('node:crypto');
const { query } = require('./drill.env');

/**
 * M9-D442 — cópia em massa de publicações agendadas para o ensaio. A PRIMEIRA publicação passa pelo pipeline de verdade (conteúdo, aprovação por outra pessoa, agendamento); as demais
 * são cópias linha a linha (item, versão e job) com ids novos, na mesma transação do ensaio. O que o ensaio mede (circuito, fila, worker) não depende de cada cópia ter
 * passado de novo pelo pipeline, e criar 100 itens pelo pipeline levava dezenas de segundos e crescia com a máquina carregada. As colunas vêm do catálogo (nenhuma lista fixa).
 */
const TABLES = Object.freeze({ items: 'content_items', versions: 'content_versions', jobs: 'publication_jobs' });

async function columnsOf(t, table) {
  const rows = await query(t, "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = :table ORDER BY ordinal_position", { table });
  return rows.map((r) => r.name);
}

/** INSERT ... SELECT da linha `sourceId` com `overrides` ({ coluna: expressão SQL }). */
async function cloneRow(t, table, columns, sourceId, overrides, replacements) {
  const select = columns.map((c) => (Object.prototype.hasOwnProperty.call(overrides, c) ? overrides[c] : `"${c}"`)).join(', ');
  await query(t, `INSERT INTO marketing.${table} (${columns.map((c) => `"${c}"`).join(', ')}) SELECT ${select} FROM marketing.${table} WHERE id = :sourceId`, { sourceId, ...replacements });
}

/** Cria `count` cópias da publicação agendada `source` ({ itemId, versionId, jobId }); devolve os ids dos jobs novos. */
async function cloneScheduled(t, source, count, titleFor) {
  if (count <= 0) return [];
  const [items, versions, jobs] = await Promise.all(Object.values(TABLES).map((table) => columnsOf(t, table)));
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const [itemId, versionId, jobId] = [randomUUID(), randomUUID(), randomUUID()];
    const r = { itemId, versionId, jobId, title: titleFor(i), oldVersion: source.versionId };
    await cloneRow(t, TABLES.items, items, source.itemId, { id: ':itemId', title: ':title', current_version_id: 'NULL' }, r);
    await cloneRow(t, TABLES.versions, versions, source.versionId, { id: ':versionId', content_item_id: ':itemId' }, r);
    await query(t, 'UPDATE marketing.content_items SET current_version_id = :versionId WHERE id = :itemId', r);
    await cloneRow(t, TABLES.jobs, jobs, source.jobId, { id: ':jobId', content_version_id: ':versionId', idempotency_key: "replace(idempotency_key, CAST(:oldVersion AS text), CAST(:versionId AS text))" }, r);
    ids.push(jobId);
  }
  return ids;
}

module.exports = { cloneScheduled };
