'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const sources = require('../ingest/source.repository');
const { loadSchema } = require('../integrity/schema.repository');
const windowService = require('../parallel/window.service');
const results = require('../parallel/results.repository');
const { tickWindow } = require('../parallel/runner');
const { KEYS, DRY_SETTING_DEFAULTS } = require('./dry.settings');

const MIN_MS = 60 * 1000;
const RULE_BY_TYPE = Object.freeze({ text: 'EXACT', int: 'EXACT', bool: 'EXACT', instant: 'EXACT', date: 'DATE', decimal: 'NUMERIC', money: 'MONEY' });

/** Regras da janela do ensaio: uma por campo mapeado, pela natureza do campo no esquema canônico (dinheiro em centavos, data pelo dia civil, o resto exato; tolerância zero). */
async function rulesFor(tenant, source, transaction) {
  const schema = new Map((await loadSchema(tenant, source.entity, transaction)).map((def) => [def.field, def.type]));
  const fields = await windowService.mappedFields(tenant, source, transaction);
  return fields.map((field) => ({ entity: source.entity, field, rule: RULE_BY_TYPE[schema.get(field)] || 'EXACT', ...(RULE_BY_TYPE[schema.get(field)] === 'MONEY' ? { oldUnit: 'CENTS', newUnit: 'CENTS' } : {}) }));
}

/**
 * Comparação paralela do ensaio (M9-D908 §3.3.2, D903): para cada sistema de origem abre uma janela curta com as regras de todos os campos, compara e, passado o fim, compara
 * de novo e fecha (a janela do ensaio não fica aberta). Devolve { windows[], blockers } com as diferenças bloqueantes em aberto; execução que falha conta como suja.
 */
async function compareAll(tenant, actor, { now = new Date() } = {}) {
  const { list, minutes } = await openTenantTx(tenant, async (transaction) => ({
    list: await sources.list(tenant, {}, transaction),
    minutes: Number(await getSetting(KEYS.WINDOW_MIN, tenant, transaction, DRY_SETTING_DEFAULTS[KEYS.WINDOW_MIN])),
  }));
  const bySystem = new Map();
  for (const source of list) bySystem.set(source.source_system, [...(bySystem.get(source.source_system) || []), source]);
  const summary = { windows: [], blockers: 0, failed: 0 };
  for (const [system, group] of bySystem) {
    const startsAt = new Date(now.getTime() - MIN_MS);
    const endsAt = new Date(now.getTime() + minutes * MIN_MS);
     
    const rules = await openTenantTx(tenant, async (transaction) => (await Promise.all(group.map((source) => rulesFor(tenant, source, transaction)))).flat());
     
    const window = await openTenantTx(tenant, (transaction) => windowService.createWindow(tenant, actor, {
      name: 'DRY3', sourceSystem: system, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), entities: group.map((source) => source.entity), intervalMin: 1, rules,
    }, transaction));
     
    const first = await tickWindow(tenant, window.id, { now, actor });
     
    const last = await tickWindow(tenant, window.id, { now: new Date(endsAt.getTime() + MIN_MS), actor });
     
    const open = await openTenantTx(tenant, (transaction) => results.openBlockers(tenant, window.id, transaction));
    const failed = [first, last].filter((tick) => tick.action === 'FAILED').length;
    summary.windows.push({ windowId: window.id, sourceSystem: system, entities: group.map((source) => source.entity), runs: [first.action, last.action], openBlockers: open.length });
    summary.blockers += open.length;
    summary.failed += failed;
  }
  return summary;
}

module.exports = { compareAll, rulesFor };
