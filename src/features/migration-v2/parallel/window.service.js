'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting } = require('../../settings/settings.service');
const { getTarget } = require('../ingest/targets');
const { loadSchema } = require('../integrity/schema.repository');
const { UUID } = require('../externalRefs.input');
const errors = require('./parallel.errors');
const { KEYS, PARALLEL_SETTING_DEFAULTS } = require('./parallel.settings');
const { parseWindow } = require('./window.input');
const windows = require('./window.repository');
const refs = require('./refs.repository');

const setting = async (key, tenant, transaction) => getSetting(key, tenant, transaction, PARALLEL_SETTING_DEFAULTS[key]);

/** Campos canônicos mapeados da fonte: os do `columnMap` da fonte e, sem mapa (linha já canônica), os do esquema canônico da entidade (M9-D905). */
async function mappedFields(tenant, source, transaction) {
  const map = source.config && source.config.columnMap;
  if (map && Object.keys(map).length) return [...new Set(Object.values(map))];
  return (await loadSchema(tenant, source.entity, transaction)).map((def) => def.field);
}

/** Toda entidade da janela tem fonte e destino, e todo campo mapeado tem regra (M9-D903 §3.3); regra de campo que ninguém mapeia também reprova. */
async function checkCoverage(tenant, parsed, transaction) {
  for (const entity of parsed.entities) {
     
    const source = await refs.sourceFor(tenant, parsed.sourceSystem, entity, transaction);
    if (!source) throw errors.windowInvalid(`Não há fonte do sistema ${parsed.sourceSystem} para a entidade ${entity}.`, { entity });
    try { getTarget(entity); } catch (err) { throw errors.windowInvalid(`Não há destino configurado para a entidade ${entity}.`, { entity }); }
     
    const fields = await mappedFields(tenant, source, transaction);
    const ruled = new Map(parsed.rules.filter((rule) => rule.entity === entity).map((rule) => [rule.field, rule]));
    const unknown = [...ruled.keys()].find((field) => !fields.includes(field));
    if (unknown) throw errors.ruleInvalid(`O campo ${unknown} não é um campo mapeado da entidade ${entity}.`, { entity, field: unknown });
    const lacking = fields.find((field) => !ruled.has(field));
    if (lacking) throw errors.ruleMissing(lacking, entity);
  }
}

const view = (row, rules) => ({
  id: row.id, name: row.name, sourceSystem: row.source_system, startsAt: row.starts_at, endsAt: row.ends_at, entities: row.entities, intervalMin: row.interval_min,
  status: row.status, closedAt: row.closed_at, createdAt: row.created_at,
  ...(rules ? { rules: rules.map((rule) => ({ entity: rule.entity, field: rule.field, rule: rule.rule, tolerance: Number(rule.tolerance), enumMap: rule.enum_map, options: rule.options })) } : {}),
});

/** POST /migration/parallel/windows (M9-D903 §5): define a janela, as entidades e as regras. A execução e o fechamento são do job. */
async function createWindow(tenant, actor, body, transaction) {
  const timeZone = String(await setting(KEYS.TIMEZONE, tenant, transaction)).trim();
  const defaultInterval = Number(await setting(KEYS.INTERVAL_MIN, tenant, transaction));
  const parsed = parseWindow(body, { timeZone, defaultInterval });
  await checkCoverage(tenant, parsed, transaction);
  const row = await windows.insertWindow(tenant, parsed, actor && actor.userId, transaction);
  await windows.insertRules(tenant, row.id, parsed.rules, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: 'migration.parallel.window.created', entityType: 'ParallelWindow', entityId: row.id,
    afterJson: { ...view(row), rules: parsed.rules.map((rule) => ({ entity: rule.entity, field: rule.field, rule: rule.rule, tolerance: rule.tolerance })) }, reason: 'Janela de comparação paralela definida.',
  }, transaction);
  return view(row, await windows.listRules(tenant, row.id, transaction));
}

async function getWindow(tenant, id, transaction) {
  if (!UUID.test(String(id || ''))) throw errors.windowNotFound();
  const row = await windows.get(tenant, id, transaction);
  if (!row) throw errors.windowNotFound();
  return { row, rules: await windows.listRules(tenant, id, transaction) };
}

module.exports = { createWindow, getWindow, view, setting, mappedFields };
