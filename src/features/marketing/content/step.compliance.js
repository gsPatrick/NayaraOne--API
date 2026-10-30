'use strict';

const repo = require('./pipeline.repository');
const { sanitizePublicFields } = require('./sanitize');
const { readPublicFieldsConfig } = require('./publicFields.settings');
const { sha256, canonicalJson } = require('./sourceStamp');
const video = require('./video');

/** Campos de texto extras do reel (M9-D426), limpos um a um com a mesma política; a legenda segue no payload principal. */
const VIDEO_EXTRA_FIELDS = Object.freeze(['roteiro', 'descricao']);

function sanitizeVideoExtras(body, policy, config) {
  const out = { fields: {}, patterns: [], count: 0 };
  for (const field of VIDEO_EXTRA_FIELDS) {
    if (typeof body[field] !== 'string') continue;
    const report = sanitizePublicFields({ texto: body[field] }, policy, config);
    out.fields[field] = report.payload.texto;
    out.patterns.push(...report.redactedPatterns);
    out.count += report.redactedCount;
  }
  return out;
}

/**
 * M9-D406 função 4 — sanitizePublicFields(payload, policy) sobre os textos que vão sair (título, texto e corpo já com a marca).
 * Se a varredura redigiu algo (CPF, e-mail, telefone...), o texto limpo vira a PRÓXIMA versão (a anterior é imutável). Sempre
 * grava o que foi removido e redigido. M9-D426: o reel passa antes pela porta de transparência e leva roteiro e descrição na mesma limpeza.
 */
async function complianceStep({ item, version, tenant, actor, transaction }) {
  const body = version.body_json;
  await video.assertVideoDisclosure({ tenant, item, version }, transaction); // reel sintético sem o aviso de transparência não segue
  const config = await readPublicFieldsConfig(tenant, transaction);
  const policy = (version.facts_snapshot_json || {}).politicaEndereco;
  const payload = { titulo: item.title, texto: body.texto };
  if (typeof body.renderizado === 'string') payload.corpo = body.renderizado;
  const report = sanitizePublicFields(payload, policy, config);
  const extras = video.isVideo(item.type) ? sanitizeVideoExtras(body, policy, config) : { fields: {}, patterns: [], count: 0 };
  const redactedCount = report.redactedCount + extras.count;
  const detalhes = { policy: report.policy, removedKeys: report.removedKeys, redactedPatterns: [...new Set([...report.redactedPatterns, ...extras.patterns])].sort(), redactedCount };
  if (redactedCount === 0) return { ok: true, detalhes };

  const nextBody = { ...body, texto: report.payload.texto, ...(report.payload.corpo !== undefined ? { renderizado: report.payload.corpo } : {}), ...extras.fields };
  const facts = version.facts_snapshot_json || {};
  const contentHash = sha256(canonicalJson({ body: nextBody, facts, template: [version.template_id, version.template_version_no] }));
  const created = await repo.insertNextVersion(tenant, actor, version, { body: nextBody, contentHash }, transaction);
  return { ok: true, detalhes: { ...detalhes, contentHash }, newVersion: created };
}

module.exports = { complianceStep };
