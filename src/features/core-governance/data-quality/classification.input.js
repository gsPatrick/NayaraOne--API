'use strict';

const errors = require('./classification.errors');
const { CLASSES, PURPOSES, MASKINGS, EXPORTABILITY } = require('./classification.constants');

const KNOWN = ['schema', 'table', 'column', 'classification', 'purpose', 'retention_policy_id', 'retentionPolicyId', 'masking', 'mask_pattern', 'maskPattern', 'exportability', 'ai_allowed', 'aiAllowed', 'owner_domain', 'ownerDomain'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const DOMAIN = /^[A-Z][A-Z0-9_]{0,39}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (body, snake, camel) => Object.prototype.hasOwnProperty.call(body, snake) || Object.prototype.hasOwnProperty.call(body, camel);
const pick = (body, snake, camel) => (body[snake] !== undefined ? body[snake] : body[camel]);

function oneOf(body, name, allowed, label) {
  if (body[name] === undefined) return undefined;
  const value = typeof body[name] === 'string' ? body[name].trim().toUpperCase() : null;
  if (!allowed.includes(value)) throw errors.validation(`${label} inválido.`, { field: name, allowed });
  return value;
}

/** Corpo do PUT /data-classification: identifica a coluna (schema, table, column) e traz só o que muda. Campo desconhecido é 400. `retention_policy_id` presente e nulo ou inválido é 422. */
function parse(body) {
  if (!isObject(body)) throw errors.validation('Corpo inválido.');
  const unknown = Object.keys(body).filter((key) => !KNOWN.includes(key));
  if (unknown.length) throw errors.validation('Campo desconhecido no corpo.', { fields: unknown });
  for (const name of ['schema', 'table', 'column']) {
    if (typeof body[name] !== 'string' || !IDENT.test(body[name])) throw errors.validation(`Informe ${name} da coluna.`, { field: name });
  }
  const changes = {};
  changes.classification = oneOf(body, 'classification', CLASSES, 'Classificação');
  changes.purpose = oneOf(body, 'purpose', PURPOSES, 'Finalidade');
  changes.masking = oneOf(body, 'masking', MASKINGS, 'Máscara');
  changes.exportability = oneOf(body, 'exportability', EXPORTABILITY, 'Exportabilidade');
  if (has(body, 'retention_policy_id', 'retentionPolicyId')) {
    const id = pick(body, 'retention_policy_id', 'retentionPolicyId');
    if (typeof id !== 'string' || !UUID.test(id)) throw errors.retentionRequired();
    changes.policyId = id.toLowerCase();
  }
  if (has(body, 'mask_pattern', 'maskPattern')) {
    const pattern = pick(body, 'mask_pattern', 'maskPattern');
    if (pattern !== null && (typeof pattern !== 'string' || pattern.length > 80)) throw errors.validation('Padrão de máscara inválido (até 80 caracteres).', { field: 'mask_pattern' });
    changes.maskPattern = pattern;
  }
  if (has(body, 'ai_allowed', 'aiAllowed')) {
    const flag = pick(body, 'ai_allowed', 'aiAllowed');
    if (typeof flag !== 'boolean') throw errors.validation('ai_allowed é verdadeiro ou falso.', { field: 'ai_allowed' });
    changes.aiAllowed = flag;
  }
  if (has(body, 'owner_domain', 'ownerDomain')) {
    const domain = String(pick(body, 'owner_domain', 'ownerDomain') || '').trim().toUpperCase();
    if (!DOMAIN.test(domain)) throw errors.validation('Domínio responsável inválido.', { field: 'owner_domain' });
    changes.ownerDomain = domain;
  }
  return { target: { schema: body.schema, table: body.table, column: body.column }, changes: Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
}

module.exports = { parse };
