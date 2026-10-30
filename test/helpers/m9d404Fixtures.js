'use strict';

// M9-D404 — fábricas de teste dos templates e da aprovação. Tudo roda dentro de uma transação com rollback (RLS real).

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../src/models');

const uid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

const TOKENS_OK = {
  colors: { primary: '#0A3D62', accent: '#E58E26' },
  fonts: { heading: 'Playfair Display', body: 'Inter' },
  logo: { fileId: uid(), sha256: sha('logo') },
  margins: { top: 24, bottom: 24 },
  proportions: { INSTAGRAM: { width: 1080, height: 1350 } },
};

function templateInput(overrides = {}) {
  return {
    code: `qa-m9-${uid().slice(0, 8)}`,
    kind: 'CONTENT',
    channel: 'INSTAGRAM',
    body: 'Novo imóvel em {{bairro}}: {{titulo}} por {{preco}}',
    variables: [
      { name: 'bairro', type: 'text' },
      { name: 'titulo', type: 'text' },
      { name: 'preco', type: 'money' },
    ],
    brandTokens: { ...TOKENS_OK, logo: undefined },
    ...overrides,
  };
}

/** Cria item de conteúdo + versão (opcionalmente aprovada com o hash do template) e devolve ids. */
async function insertContent(t, tenant, { templateRow = null, approvedHash = null, itemStatus = 'APPROVED', contentHash = sha(uid()) } = {}) {
  const [item] = await q(
    t,
    `INSERT INTO marketing.content_items (id, group_id, company_id, type, title, status)
     VALUES (gen_random_uuid(), :g, :c, 'NEW_PROPERTY', 'QA-M9 conteúdo', :s) RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, s: itemStatus }
  );
  const [version] = await q(
    t,
    `INSERT INTO marketing.content_versions (id, group_id, company_id, content_item_id, version_no, body_json, content_hash,
        template_id, template_version_no, approved_by, approved_at, approved_hash)
     VALUES (gen_random_uuid(), :g, :c, :item, 1, '{"texto":"x"}'::jsonb, :ch, :tid, :tv, :by, :at, :ah) RETURNING id`,
    {
      g: tenant.groupId, c: tenant.companyId, item: item.id, ch: contentHash,
      tid: templateRow ? templateRow.id : null, tv: templateRow ? templateRow.versionNo : null,
      by: approvedHash ? 'QA aprovador' : null, at: approvedHash ? new Date() : null, ah: approvedHash,
    }
  );
  await q(t, 'UPDATE marketing.content_items SET current_version_id = :v WHERE id = :i', { v: version.id, i: item.id });
  return { itemId: item.id, versionId: version.id, contentHash };
}

async function insertNextVersion(t, tenant, itemId, templateRow, versionNo = 2) {
  const [version] = await q(
    t,
    `INSERT INTO marketing.content_versions (id, group_id, company_id, content_item_id, version_no, body_json, content_hash,
        template_id, template_version_no)
     VALUES (gen_random_uuid(), :g, :c, :item, :n, '{"texto":"y"}'::jsonb, :ch, :tid, :tv) RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, item: itemId, n: versionNo, ch: sha(uid()), tid: templateRow.id, tv: templateRow.versionNo }
  );
  await q(t, 'UPDATE marketing.content_items SET current_version_id = :v WHERE id = :i', { v: version.id, i: itemId });
  return version.id;
}

async function insertJob(t, tenant, versionId, status = 'PENDING', channel = 'INSTAGRAM') {
  const [job] = await q(
    t,
    `INSERT INTO marketing.publication_jobs (id, group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
     VALUES (gen_random_uuid(), :g, :c, :v, :ch, 'sandbox', :s, :k, now() + interval '1 hour') RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, v: versionId, ch: channel, s: status, k: `pub:${versionId}:${channel}:${uid().slice(0, 8)}` }
  );
  return job.id;
}

module.exports = { uid, sha, q, templateInput, TOKENS_OK, insertContent, insertNextVersion, insertJob };
