'use strict';

/**
 * M9-D611 (3.1) — especificação de origem de cada métrica: qual tabela e quais colunas reproduzem o número. Cada demanda de KPI
 * registra a sua com `registerSourceSpec`. Tudo que vira SQL é identificador validado aqui (nunca vem do usuário); valores do filtro
 * vão sempre por parâmetro.
 *
 *   registerSourceSpec({
 *     metricCode: 'fin.free_cash', type: 'LEDGER_ENTRIES', table: 'finance.financial_entries',
 *     idColumn: 'id', companyColumn: 'company_id',
 *     columns: { period: 'settled_at', status: 'status', nature: 'nature', equals: { thirdParty: 'is_third_party_funds' } },
 *     valueColumn: 'amount', valueSign: { column: 'nature', negative: ['PAYABLE'] },   // modo SUM
 *     formulaId: '...', rowColumns: ['...'], formulaParams: {},                       // modo RECOMPUTE
 *     describe: (filter) => 'Lançamentos liquidados da empresa ...',
 *   })
 *   registerSourceSpec({ metricCode: 'fin.breathing_need', components: ['fin.payables_30d', 'fin.free_cash'] })   // KPI composto
 */
const { MODES } = require('./sourceRefs.mode');

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const CODE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const specs = new Map();

function fail(spec, message) {
  throw new Error(`Origem do indicador ${spec && spec.metricCode}: ${message}`);
}

function assertColumns(spec) {
  const c = spec.columns || {};
  for (const key of ['period', 'status', 'nature']) if (c[key] !== undefined && !IDENT.test(c[key])) fail(spec, `columns.${key} inválido.`);
  for (const [name, col] of Object.entries(c.equals || {})) if (!IDENT.test(name) || !IDENT.test(col)) fail(spec, `columns.equals.${name} inválido.`);
}

function assertLeaf(spec) {
  if (!TABLE.test(spec.table || '')) fail(spec, 'informe table no formato schema.tabela.');
  if (typeof spec.type !== 'string' || !spec.type) fail(spec, 'informe type.');
  if (!IDENT.test(spec.idColumn || 'id') || !IDENT.test(spec.companyColumn || 'company_id')) fail(spec, 'idColumn/companyColumn inválido.');
  assertColumns(spec);
  if (spec.valueColumn !== undefined && !IDENT.test(spec.valueColumn)) fail(spec, 'valueColumn inválido.');
  if (spec.valueSign && (!IDENT.test(spec.valueSign.column) || !Array.isArray(spec.valueSign.negative))) fail(spec, 'valueSign inválido.');
  if (spec.rowColumns !== undefined && !(Array.isArray(spec.rowColumns) && spec.rowColumns.every((c) => IDENT.test(c)))) fail(spec, 'rowColumns inválido.');
  if (spec.reconcileMode !== undefined && !MODES.includes(spec.reconcileMode)) fail(spec, 'reconcileMode inválido.');
  if (typeof spec.describe !== 'function') fail(spec, 'informe describe(filter) em linguagem de negócio.');
}

function registerSourceSpec(spec) {
  if (!spec || !CODE.test(spec.metricCode || '')) fail(spec, 'metricCode deve seguir dominio.nome_em_snake.');
  if (specs.has(spec.metricCode)) fail(spec, 'já registrada.');
  if (spec.components !== undefined) {
    if (!Array.isArray(spec.components) || !spec.components.length || !spec.components.every((c) => CODE.test(c))) fail(spec, 'components deve listar códigos de métrica.');
  } else {
    assertLeaf(spec);
  }
  specs.set(spec.metricCode, Object.freeze({ idColumn: 'id', companyColumn: 'company_id', ...spec }));
  return specs.get(spec.metricCode);
}

const getSourceSpec = (metricCode) => specs.get(metricCode) || null;
const listSourceSpecs = () => [...specs.values()];
const unregisterSourceSpec = (metricCode) => specs.delete(metricCode); // só para teste

module.exports = { registerSourceSpec, getSourceSpec, listSourceSpecs, unregisterSourceSpec };
