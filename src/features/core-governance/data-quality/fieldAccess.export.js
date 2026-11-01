'use strict';

const AppError = require('../../../utils/AppError');
const classification = require('./classification.service');
const fieldAccess = require('./fieldAccess.service');
const { applyMasking } = require('./fieldAccess.mask');

/**
 * Exportabilidade por coluna (M9-D915 §3.3), para os exportadores de `dlp/exports`. A coluna do catálogo aponta para a coluna do registro (`registryTable` + o nome em
 * snake_case, ou `registryColumn`). Pedido: coluna FORBIDDEN listada em `columns` recusa o pedido inteiro (403 GOV_EXPORT_FIELD_FORBIDDEN, nada é gerado); sem lista, a coluna
 * sai do arquivo e o pedido guarda o aviso. Arquivo: ALLOWED em claro, ALLOWED_MASKED mascarada, WITH_APPROVAL em claro só quando o guard liberou, FORBIDDEN fora.
 */
const entityOf = (entry) => entry.registryTable || null;
const columnOf = (column) => column.registryColumn || column.key;

const forbidden = () => new AppError('Este campo não pode ser exportado.', 403, 'GOV_EXPORT_FIELD_FORBIDDEN');

/** Aplica a exportabilidade ao pedido: devolve { columns, warnings }. `listed` = o pedido trouxe `columns`. Lança 403 GOV_EXPORT_FIELD_FORBIDDEN quando a coluna listada é proibida. */
async function applyRequestPolicy(tenant, entry, columns, listed, transaction) {
  const entity = entityOf(entry);
  if (!entity || !columns.length) return { columns, warnings: [] };
  const [schema, table] = entity.split('.');
  const blocked = [];
  for (const key of columns) {
    const column = entry.columns.find((c) => c.key === key);
    const spec = await classification.resolveColumn(tenant, schema, table, fieldAccess.toSnake(columnOf(column || { key })), transaction);
    if (spec.exportability === 'FORBIDDEN') blocked.push(key);
  }
  if (!blocked.length) return { columns, warnings: [] };
  const rest = columns.filter((key) => !blocked.includes(key));
  if (listed || !rest.length) {
    const error = forbidden();
    error.details = { fields: blocked };
    throw error;
  }
  return { columns: rest, warnings: blocked.map((key) => `coluna ${key} omitida`) };
}

/**
 * Mascara as linhas do arquivo conforme o registro. `actor`: { groupId, companyId, userId, permissions }. Devolve { columns, rows, maskedColumns, omittedColumns }: `columns` já sem
 * as omitidas. Entrada sem `registryTable` não passa por aqui (o chamador usa a máscara do catálogo).
 */
async function maskExportRows(actor, entry, columns, rows, { approved, maskText, transaction }) {
  const entity = entityOf(entry);
  const decided = await fieldAccess.resolveFields(entity, columns.map((c) => ({ field: columnOf(c), minClassification: c.classification })), actor, 'EXPORT', {
    transaction, approved, maskText, originPermission: entry.permission, rowCount: rows.length,
  });
  const byKey = new Map(columns.map((c, index) => [c.key, decided[index]]));
  const kept = columns.filter((c) => byKey.get(c.key).visible);
  const omittedColumns = columns.filter((c) => !byKey.get(c.key).visible).map((c) => c.key);
  const maskedKeys = kept.filter((c) => byKey.get(c.key).rule.outcome === 'MASKED').map((c) => c.key);
  const out = rows.map((row) => {
    const next = { ...row };
    for (const key of omittedColumns) delete next[key];
    for (const key of maskedKeys) {
      const { rule } = byKey.get(key);
      next[key] = applyMasking(row[key], rule.masking, { field: fieldAccess.toSnake(columnOf(kept.find((c) => c.key === key))), maskPattern: rule.maskPattern, companyId: actor.companyId, maskText });
    }
    return next;
  });
  return { columns: kept, rows: out, maskedColumns: maskedKeys, omittedColumns };
}

module.exports = { applyRequestPolicy, maskExportRows, forbidden };
