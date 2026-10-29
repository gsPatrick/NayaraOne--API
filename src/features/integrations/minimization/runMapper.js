'use strict';

const { exceeds, fromDocumentScale } = require('./classification');
const { PSEUDONYMIZED_DOMAINS, PSEUDONYMIZED_CEILING, CONSENT_FOR_SENSITIVE_DOMAINS } = require('./purposeLimits');
const { classificationViolation, requiredMissing, entityNotAllowed } = require('./minimization.errors');
const { redactFreeText } = require('../../../shared/redaction');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc !== null && acc !== undefined && typeof acc === 'object' ? acc[key] : undefined), obj);
const absent = (v) => v === undefined || v === null || v === '';

/** Valor seguro para o payload: escalar, data em ISO, lista de escalares ou objeto simples de escalares. Entidade: recusa. */
function toPlain(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return value;
  if (t === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  throw entityNotAllowed();
}

/** Classificação efetiva do campo na escala de integração (a de documento/IA vem convertida; desconhecida = SENSITIVE). */
function classOf(field, source) {
  if (!field.classificationFrom) return field.classification;
  const raw = getPath(source, field.classificationFrom);
  if (absent(raw)) return field.classification;
  return fromDocumentScale(String(raw), { hasPersonalData: Boolean(field.personalData) }) || 'SENSITIVE';
}

function allowed(field, cls, ctx) {
  if (exceeds(cls, ctx.maxClassification)) {
    const pseudonymOk = PSEUDONYMIZED_DOMAINS.includes(ctx.domain) && field.pseudonymized === true && !exceeds(cls, PSEUDONYMIZED_CEILING);
    if (!pseudonymOk) return false;
  }
  const needsConsent = field.requiresConsent === true || (CONSENT_FOR_SENSITIVE_DOMAINS.includes(ctx.domain) && cls === 'SENSITIVE');
  return !needsConsent || (Array.isArray(ctx.consentedFields) && ctx.consentedFields.includes(field.name));
}

function mapFields(fields, source, ctx, prefix, report) {
  const payload = {};
  const roots = new Set(fields.flatMap((f) => [f.from || f.name, f.classificationFrom].filter(Boolean).map((path) => path.split('.')[0])));
  fields.forEach((field) => {
    const label = `${prefix}${field.name}`;
    const raw = getPath(source, field.from || field.name);
    if (absent(raw)) {
      if (field.required) throw requiredMissing(label);
      return;
    }
    if (!allowed(field, classOf(field, source), ctx)) {
      if (field.required) throw classificationViolation(label);
      report.dropped.push(label);
      return;
    }
    if (field.items) {
      payload[field.name] = (Array.isArray(raw) ? raw : []).filter(isPlain).map((item) => mapFields(field.items, item, ctx, `${label}[].`, report));
    } else if (field.shape) {
      if (!isPlain(raw)) throw entityNotAllowed();
      payload[field.name] = mapFields(field.shape, raw, ctx, `${label}.`, report);
    } else {
      payload[field.name] = field.freeText && typeof raw === 'string' ? redactFreeText(raw) : toPlain(raw);
    }
    report.kept.push(label);
  });
  Object.keys(source).filter((key) => !roots.has(key)).forEach((key) => report.dropped.push(`${prefix}${key}`));
  return payload;
}

/**
 * runMapper(spec, domainObject, ctx) — aplica a allowlist e a classificação. `ctx`: { domain, maxClassification, consentedFields }.
 * Devolve { payload, purpose, fieldsKept, fieldsDropped } (só NOMES de campo, nunca valores). Entidade/DTO interno: 500.
 */
function runMapper(spec, domainObject, ctx) {
  if (!isPlain(domainObject)) throw entityNotAllowed();
  const report = { kept: [], dropped: [] };
  const payload = mapFields(spec.fields, domainObject, ctx, '', report);
  return { payload, purpose: spec.purpose, fieldsKept: report.kept, fieldsDropped: [...new Set(report.dropped)] };
}

module.exports = { runMapper, toPlain };
