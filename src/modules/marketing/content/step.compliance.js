'use strict';

const repo = require('./pipeline.repository');
const { sanitizePublicFields } = require('./sanitize');
const { readPublicFieldsConfig } = require('./publicFields.settings');
const { sha256, canonicalJson } = require('./sourceStamp');

/**
 * M9-D406 função 4 — sanitizePublicFields(payload, policy) sobre os textos que vão sair (título, texto e corpo já com a marca).
 * Se a varredura redigiu algo (CPF, e-mail, telefone...), o texto limpo vira a PRÓXIMA versão (a anterior é imutável). Sempre
 * grava o que foi removido e redigido.
 */
async function complianceStep({ item, version, tenant, actor, transaction }) {
  const body = version.body_json;
  const config = await readPublicFieldsConfig(tenant, transaction);
  const payload = { titulo: item.title, texto: body.texto };
  if (typeof body.renderizado === 'string') payload.corpo = body.renderizado;
  const report = sanitizePublicFields(payload, (version.facts_snapshot_json || {}).politicaEndereco, config);
  const detalhes = { policy: report.policy, removedKeys: report.removedKeys, redactedPatterns: report.redactedPatterns, redactedCount: report.redactedCount };
  if (report.redactedCount === 0) return { ok: true, detalhes };

  const nextBody = { ...body, texto: report.payload.texto, ...(report.payload.corpo !== undefined ? { renderizado: report.payload.corpo } : {}) };
  const facts = version.facts_snapshot_json || {};
  const contentHash = sha256(canonicalJson({ body: nextBody, facts, template: [version.template_id, version.template_version_no] }));
  const created = await repo.insertNextVersion(tenant, actor, version, { body: nextBody, contentHash }, transaction);
  return { ok: true, detalhes: { ...detalhes, contentHash }, newVersion: created };
}

module.exports = { complianceStep };
