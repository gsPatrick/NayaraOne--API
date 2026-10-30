'use strict';

// Apoio dos testes M9-D426/M9-D428 (mídia e vídeo do Marketing): arquivo do módulo de arquivos, autorização, montagem e reel até a aprovação. Não é teste.
const crypto = require('node:crypto');
const env = require('./mktAgenda');
const video = require('../../../src/features/marketing/content/video');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { fx } = env;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const authOf = (tenant) => ({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: ['marketing:content:approve'] });

/** Arquivo do módulo de arquivos (metadado) enviado pelo usuário do teste: por padrão vídeo MP4 limpo no antivírus. */
async function makeFile(t, tenant, { mime = 'video/mp4', name = 'midia.mp4', size = 2048, scan = 'CLEAN', seed = crypto.randomUUID() } = {}) {
  const [row] = await fx.q(t, `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, checksum_sha256, scan_status, uploaded_by_user_id, created_by)
    VALUES (gen_random_uuid(), :g, :c, :k, :n, :m, :s, :h, :scan, :u, :u) RETURNING id, checksum_sha256`,
  { g: tenant.groupId, c: tenant.companyId, k: `marketing/${tenant.groupId}/${seed}-${name}`, n: name, m: mime, s: size, h: sha(seed), scan, u: tenant.userId });
  return { id: row.id, sha256: row.checksum_sha256 };
}

/** `dims`: { width, height, durationS } declarados por quem autoriza (M9-D428: o servidor não examina o arquivo). */
const authorize = (t, tenant, fileId, origin = 'EQUIPE', dims = {}) => video.authorizeMedia({ tenant, auth: authOf(tenant), fileId, origin, ...dims }, t);

/** Arquivo já autorizado. */
async function authorizedFile(t, tenant, opts = {}) {
  const file = await makeFile(t, tenant, opts);
  await authorize(t, tenant, file.id, opts.origin || 'EQUIPE', opts.dims);
  return file;
}

const assemble = (t, tenant, assembly) => video.assembleReel({ tenant, actor: tenant.userId, assembly }, t);
const setParam = (t, tenant, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);

/** Reel percorrido pelo pipeline (NAY desligada: texto à mão). `input` completa/substitui o corpo. */
function createReel(t, ctx, input) {
  return env.service.createAndRun({ tenant: ctx.tenant, actor: ctx.tenant.userId, input: { type: 'VIDEO_REEL', title: 'QA-M9 reel', texto: 'Tour pelo apartamento.', ...input } }, fx.sameTx(t));
}

const fileRow = async (t, id) => (await fx.q(t, 'SELECT * FROM people.files WHERE id = :id', { id }))[0];
const count = async (t, table, where = 'true', replacements = {}) => (await fx.q(t, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, replacements))[0].n;

module.exports = { ...env, sha, authOf, makeFile, authorize, authorizedFile, assemble, setParam, createReel, fileRow, count, video };
