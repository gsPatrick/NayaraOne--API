'use strict';

const errors = require('./retention.errors');
const targets = require('./retention.targets');
const { TRIGGERS, DISPOSITIONS, EXCEPTIONS, LEGAL_BASES, ART11 } = require('./retention.constants');

const KNOWN = ['code', 'name', 'retention_months', 'retentionMonths', 'trigger', 'legal_basis', 'legalBasis', 'disposition', 'exceptions', 'owner_domain', 'ownerDomain', 'data_types', 'dataTypes', 'auto_apply', 'autoApply'];
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const DOMAIN = /^[A-Z][A-Z0-9_]{0,39}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (body, snake, camel) => (body[snake] !== undefined ? body[snake] : body[camel]);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function legalBasisOf(raw, existing) {
  const source = raw === undefined ? existing : raw;
  if (!isObject(source)) throw errors.legalBasisRequired();
  const code = text(source.code);
  const referenceText = text(pick(source, 'reference_text', 'referenceText'));
  if (!code || !referenceText) throw errors.legalBasisRequired();
  if (!LEGAL_BASES[code] && !ART11.test(code)) throw errors.legalBasisInvalid({ code });
  return { code, text: text(source.text) || LEGAL_BASES[code] || `LGPD, art. 11: ${code.replace('LGPD_ART11_', '').toLowerCase()} (dado sensível).`, referenceText };
}

function monthsOf(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1200) throw errors.periodInvalid({ retentionMonths: value });
  return value;
}

function listOf(value, label, allowed) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw errors.validation(`O campo ${label} deve ser uma lista de textos.`, { field: label });
  const list = [...new Set(value.map((item) => item.trim().toUpperCase()))];
  const unknown = list.filter((item) => !allowed(item));
  if (unknown.length) throw errors.validation(`O campo ${label} tem valor desconhecido.`, { field: label, unknown });
  return list;
}

/**
 * Corpo do PUT /retention/policies: campo omitido mantém o da política existente (ou o padrão de uma política nova); campo desconhecido é 400. Ordem das recusas do livro:
 * base legal (422), prazo (422) e exceção LEGAL_HOLD (422); depois os alvos, o gatilho e a disposição que o alvo suporta.
 */
function parsePolicyBody(body, existing) {
  if (!isObject(body)) throw errors.validation('Corpo inválido.');
  const unknownFields = Object.keys(body).filter((key) => !KNOWN.includes(key));
  if (unknownFields.length) throw errors.validation('Campo desconhecido no corpo.', { fields: unknownFields });
  const code = text(body.code).toUpperCase();
  if (!CODE.test(code)) throw errors.validation('Informe o código da política (letras maiúsculas, números e _).', { field: 'code' });
  const base = existing || {};
  const legalBasis = legalBasisOf(pick(body, 'legal_basis', 'legalBasis'), existing && { code: existing.legalBasis.code, text: existing.legalBasis.text, referenceText: existing.legalBasis.referenceText });
  const disposition = body.disposition === undefined ? base.disposition : text(body.disposition).toUpperCase();
  if (!disposition || !Object.values(DISPOSITIONS).includes(disposition)) throw errors.validation('Disposição inválida (DELETE, ANONYMIZE, ARCHIVE ou REVIEW).', { field: 'disposition' });
  const rawMonths = pick(body, 'retention_months', 'retentionMonths');
  const retentionMonths = monthsOf(rawMonths === undefined ? base.retentionMonths : rawMonths);
  if (retentionMonths === 0 && disposition !== DISPOSITIONS.REVIEW) throw errors.periodInvalid({ retentionMonths, reason: 'O prazo 0 só vale com a disposição REVIEW.' });
  const exceptions = body.exceptions === undefined ? base.exceptions : listOf(body.exceptions, 'exceptions', (e) => EXCEPTIONS.includes(e));
  if (!exceptions || !exceptions.includes('LEGAL_HOLD')) throw errors.holdExceptionRequired();
  const trigger = body.trigger === undefined ? base.trigger : text(body.trigger).toUpperCase();
  if (!TRIGGERS.includes(trigger)) throw errors.validation('Gatilho inválido.', { field: 'trigger', allowed: TRIGGERS });
  const dataTypes = pick(body, 'data_types', 'dataTypes') === undefined ? (base.dataTypes || []) : listOf(pick(body, 'data_types', 'dataTypes'), 'data_types', (t) => !!targets.get(t));
  const ownerDomain = text(pick(body, 'owner_domain', 'ownerDomain') === undefined ? base.ownerDomain : pick(body, 'owner_domain', 'ownerDomain')).toUpperCase();
  if (!DOMAIN.test(ownerDomain)) throw errors.validation('Informe o domínio responsável.', { field: 'owner_domain' });
  const name = text(body.name === undefined ? base.name : body.name);
  if (!name || name.length > 120) throw errors.validation('Informe o nome da política (até 120 caracteres).', { field: 'name' });
  const rawAuto = pick(body, 'auto_apply', 'autoApply');
  if (rawAuto !== undefined && typeof rawAuto !== 'boolean') throw errors.validation('O campo auto_apply é verdadeiro ou falso.', { field: 'auto_apply' });
  const autoApply = rawAuto === undefined ? Boolean(base.autoApply) : rawAuto;
  return { code, name, retentionMonths, trigger, legalBasis, disposition, exceptions, dataTypes, ownerDomain, autoApply };
}

/** Cada alvo da política precisa aceitar o gatilho e a disposição escolhidos; a aplicação automática só vale para alvo seguro. */
function assertTargetsFit(policy) {
  for (const code of policy.dataTypes) {
    const target = targets.get(code);
    if (!Object.prototype.hasOwnProperty.call(target.triggers, policy.trigger)) throw errors.unsupported('GOV_RETENTION_TRIGGER_UNSUPPORTED', 'O tipo de dado não aceita este gatilho.', { target: code, trigger: policy.trigger, accepted: Object.keys(target.triggers) });
    if (!target.dispositions.includes(policy.disposition)) throw errors.unsupported('GOV_RETENTION_DISPOSITION_UNSUPPORTED', 'O tipo de dado não aceita esta disposição.', { target: code, disposition: policy.disposition, accepted: target.dispositions });
    if (policy.autoApply && !target.autoApplySafe) throw errors.autoApplyUnsafe();
  }
}

module.exports = { parsePolicyBody, assertTargetsFit };
