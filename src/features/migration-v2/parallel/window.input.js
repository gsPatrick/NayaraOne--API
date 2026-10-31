'use strict';

const errors = require('./parallel.errors');
const { RULES, MONEY_UNITS } = require('./compare.rule');
const { parseWindowInstant } = require('./time.local');
const { normalizeSystem } = require('../externalRefs.input');

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const INTERVAL_MAX = 1440;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseEntities(value) {
  if (!Array.isArray(value) || !value.length) throw errors.windowInvalid('Informe ao menos uma entidade para comparar.');
  const out = [...new Set(value.map((entity) => String(entity === undefined || entity === null ? '' : entity).trim().toUpperCase()))];
  if (out.some((entity) => !/^[A-Z][A-Z0-9_]{1,29}$/.test(entity))) throw errors.windowInvalid('Entidade inválida na lista da janela.');
  return out;
}

function parseRule(raw, entities) {
  if (!isObject(raw)) throw errors.ruleInvalid('Cada regra deve ser um objeto com entidade, campo e regra.');
  const entity = String(raw.entity || '').trim().toUpperCase();
  const field = String(raw.field || '').trim();
  if (!entities.includes(entity)) throw errors.ruleInvalid('A regra aponta para uma entidade que não está na janela.', { entity });
  if (!FIELD.test(field)) throw errors.ruleInvalid('Nome de campo inválido na regra.', { entity, field });
  const rule = String(raw.rule || '').trim().toUpperCase();
  if (!RULES.includes(rule)) throw errors.ruleInvalid(`A regra do campo ${field} deve ser uma de ${RULES.join(', ')}.`, { entity, field });
  const tolerance = raw.tolerance === undefined || raw.tolerance === null ? 0 : Number(raw.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw errors.ruleInvalid(`A tolerância do campo ${field} deve ser um número zero ou maior.`, { entity, field });
  if (rule !== 'NUMERIC' && tolerance !== 0) throw errors.ruleInvalid(rule === 'MONEY' ? 'Dinheiro tem sempre tolerância zero.' : `A regra ${rule} não aceita tolerância.`, { entity, field });
  let enumMap = null;
  if (rule === 'ENUM_MAP') {
    if (!isObject(raw.enumMap) || !Object.keys(raw.enumMap).length) throw errors.ruleInvalid(`Informe o mapa de status antigo para novo do campo ${field}.`, { entity, field });
    enumMap = Object.fromEntries(Object.entries(raw.enumMap).map(([from, to]) => [String(from).trim(), String(to === null || to === undefined ? '' : to).trim()]));
  } else if (raw.enumMap !== undefined && raw.enumMap !== null) throw errors.ruleInvalid(`Só a regra ENUM_MAP aceita mapa de status (campo ${field}).`, { entity, field });
  const options = {};
  if (rule === 'MONEY') {
    for (const side of ['oldUnit', 'newUnit']) {
      const unit = raw[side] === undefined || raw[side] === null ? 'CENTS' : String(raw[side]).toUpperCase();
      if (!MONEY_UNITS.includes(unit)) throw errors.ruleInvalid(`A unidade ${side} do campo ${field} deve ser CENTS ou DECIMAL.`, { entity, field });
      options[side] = unit;
    }
  }
  return { entity, field, rule, tolerance, enumMap, options };
}

/** Corpo de POST /migration/parallel/windows: período em fuso, entidades, regras e intervalo (ausente = o padrão do parâmetro). */
function parseWindow(body, { timeZone, defaultInterval }) {
  const input = isObject(body) ? body : {};
  const startsAt = parseWindowInstant(input.startsAt, timeZone);
  const endsAt = parseWindowInstant(input.endsAt, timeZone);
  if (!startsAt || !endsAt) throw errors.windowInvalid('Informe o início e o fim da janela como datas válidas.');
  if (endsAt <= startsAt) throw errors.endBeforeStart();
  let sourceSystem;
  try { sourceSystem = normalizeSystem(input.sourceSystem); } catch (err) { throw errors.windowInvalid('Informe o sistema antigo da janela (sourceSystem).'); }
  const entities = parseEntities(input.entities);
  let intervalMin = defaultInterval;
  if (input.intervalMin !== undefined && input.intervalMin !== null) {
    intervalMin = Number(input.intervalMin);
    if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > INTERVAL_MAX) throw errors.windowInvalid(`O intervalo deve ser um número inteiro de 1 a ${INTERVAL_MAX} minutos.`);
  }
  const rules = (Array.isArray(input.rules) ? input.rules : []).map((raw) => parseRule(raw, entities));
  const seen = new Set();
  for (const rule of rules) {
    const key = `${rule.entity}|${rule.field}`;
    if (seen.has(key)) throw errors.ruleInvalid(`O campo ${rule.field} tem mais de uma regra.`, { entity: rule.entity, field: rule.field });
    seen.add(key);
  }
  const name = input.name === undefined || input.name === null ? null : String(input.name).trim().slice(0, 120) || null;
  return { name, sourceSystem, startsAt, endsAt, entities, intervalMin, rules };
}

module.exports = { parseWindow };
