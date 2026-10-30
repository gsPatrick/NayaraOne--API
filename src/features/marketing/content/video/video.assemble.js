'use strict';

const { sequelize } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { uploadFile } = require('../../../files/files.service');
const { sha256, canonicalJson } = require('../sourceStamp');
const repo = require('./media.repository');
const { assertAuthorized } = require('./media.service');
const { validateOperations } = require('./video.operations');
const { parseSyntheticElements, assertRenderPhrase } = require('./video.synthetic');
const { render } = require('./video.render');
const { readVideoConfig } = require('./video.settings');
const { videoInvalid } = require('./video.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = Object.freeze(['REEL', 'VIDEO']);
const RATIO_RE = /^\d{1,2}:\d{1,2}$/;
const FIELDS = ['midias', 'operacoes', 'elementosSinteticos', 'formato', 'proporcao', 'duracaoS'];

/** Confere o corpo `montagem` da criação do conteúdo; campo desconhecido é 400. */
function parseAssembly(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw videoInvalid('Dados inválidos: montagem.', { field: 'montagem' });
  const unknown = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw videoInvalid(`Dados inválidos: campo(s) desconhecido(s) em montagem: ${unknown.join(', ')}.`, { unknown });
  const mediaIds = Array.isArray(raw.midias) ? raw.midias.map((m) => String(m || '').trim()) : [];
  if (mediaIds.length === 0 || !mediaIds.every((m) => UUID_RE.test(m)) || new Set(mediaIds).size !== mediaIds.length) throw videoInvalid('Dados inválidos: montagem.midias.', { field: 'montagem.midias' });
  const format = raw.formato === undefined ? 'REEL' : String(raw.formato).trim().toUpperCase();
  if (!FORMATS.includes(format)) throw videoInvalid('Dados inválidos: montagem.formato.', { field: 'montagem.formato', validos: FORMATS });
  const aspectRatio = raw.proporcao === undefined ? '9:16' : String(raw.proporcao).trim();
  if (!RATIO_RE.test(aspectRatio)) throw videoInvalid('Dados inválidos: montagem.proporcao (ex.: 9:16).', { field: 'montagem.proporcao' });
  if (raw.duracaoS !== undefined && (!Number.isInteger(raw.duracaoS) || raw.duracaoS < 1 || raw.duracaoS > 36000)) throw videoInvalid('Dados inválidos: montagem.duracaoS.', { field: 'montagem.duracaoS' });
  return { mediaIds, operations: validateOperations(raw.operacoes), syntheticKinds: parseSyntheticElements(raw.elementosSinteticos), format, aspectRatio, durationS: raw.duracaoS };
}

function assertOperationsUseGivenMedia(operations, mediaIds) {
  const given = new Set(mediaIds);
  const used = operations.flatMap((o) => [o.mediaId, ...(o.order || [])]).filter(Boolean);
  if (used.some((id) => !given.has(id))) throw videoInvalid('A operação cita uma mídia que não está na montagem.', { field: 'montagem.operacoes' });
}

/**
 * Monta o reel (M9-D426 regras 1 a 4): cada mídia precisa estar autorizada (422 MKT_MEDIA_NOT_AUTHORIZED); só operações da allowlist (422 MKT_MEDIA_MATERIAL_ALTERATION);
 * renderização de projeto leva a legenda "Imagem ilustrativa". O resultado é um arquivo NOVO (derived_from = id e SHA-256 de cada original, transform_log com as operações):
 * o original nunca é lido para escrita. Idempotente: as mesmas entradas devolvem o derivado existente (hash das entradas, sob trava por empresa e hash).
 */
async function assembleReel({ tenant, actor, assembly }, transaction) {
  const spec = parseAssembly(assembly);
  assertOperationsUseGivenMedia(spec.operations, spec.mediaIds);
  const config = await readVideoConfig(tenant, transaction);
  if (spec.mediaIds.length > config.maxMedia) throw videoInvalid('Mídias demais para uma montagem.', { field: 'montagem.midias', max: config.maxMedia });
  const sources = [];
  const kinds = new Set(spec.syntheticKinds);
  for (const fileId of spec.mediaIds) {
    const { authorization } = await assertAuthorized(fileId, transaction);
    sources.push({ fileId, sha256: authorization.sha256, origin: authorization.origin });
    if (authorization.origin === 'RENDER_PROJETO') kinds.add('RENDER');
  }
  const syntheticKinds = [...kinds].sort();
  assertRenderPhrase(syntheticKinds, spec.operations.filter((o) => o.op === 'CAPTION').map((o) => o.text), config);

  const inputsHash = sha256(canonicalJson({ sources: sources.map(({ fileId, sha256: h }) => ({ fileId, sha256: h })), operations: spec.operations, syntheticKinds, format: spec.format, aspectRatio: spec.aspectRatio, durationS: spec.durationS || null }));
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 426))', { replacements: { key: `mkt_video:${tenant.companyId}:${inputsHash}` }, transaction });
  const existing = await repo.findDerivativeByInputs(inputsHash, transaction);
  if (existing) return { derivative: existing, replay: true };

  const out = await render({ sources: sources.map(({ fileId, sha256: h }) => ({ fileId, sha256: h })), operations: spec.operations, format: spec.format, aspectRatio: spec.aspectRatio, durationS: spec.durationS, syntheticKinds });
  const file = await uploadFile({
    groupId: tenant.groupId, companyId: tenant.companyId, fileName: `reel-${inputsHash.slice(0, 12)}.mp4`, mimeType: out.mimeType || 'video/mp4',
    contentBase64: out.buffer.toString('base64'), category: 'marketing',
  }, actor, transaction);
  const derivative = await repo.insertDerivative(tenant, {
    inputsHash, derivedFileId: file.id, derivedSha256: file.checksumSha256, derivedFrom: sources.map(({ fileId, sha256: h }) => ({ fileId, sha256: h })),
    transformLog: { operations: spec.operations, order: spec.mediaIds, syntheticKinds }, format: spec.format, aspectRatio: out.aspectRatio || spec.aspectRatio,
    durationS: out.durationS, synthetic: syntheticKinds.length > 0, syntheticKinds, actor,
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.media.assemble', entityType: 'MarketingMediaDerivative', entityId: derivative.id,
    beforeJson: null, afterJson: { derivedFileId: file.id, derivedSha256: file.checksumSha256, derivedFrom: derivative.derived_from, synthetic: derivative.synthetic, kinds: syntheticKinds },
    reason: 'Reel montado a partir de mídia autorizada; os originais não foram alterados.',
  }, transaction);
  return { derivative, replay: false };
}

module.exports = { assembleReel, parseAssembly };
