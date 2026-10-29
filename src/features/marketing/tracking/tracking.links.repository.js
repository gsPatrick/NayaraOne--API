'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL de marketing.tracking_links (M9-D431). RLS por grupo e empresa vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLUMNS = `id, campaign_id, content_item_id, short_code, target_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  channel, signature, expires_at, status, created_at`;

/** Localiza o link e a empresa dele SEM sessão de tenant (rota pública): função SECURITY DEFINER que só devolve ids. */
async function resolveRouting(shortCode, transaction) {
  const [row] = await run('SELECT id, group_id, company_id FROM marketing.resolve_tracking_link(:shortCode)', { shortCode }, transaction);
  return row || null;
}

async function findByShortCode(shortCode, transaction) {
  const [row] = await run(`SELECT ${COLUMNS} FROM marketing.tracking_links WHERE short_code = :shortCode AND deleted_at IS NULL`, { shortCode }, transaction);
  return row || null;
}

async function findById(id, transaction) {
  const [row] = await run(`SELECT ${COLUMNS} FROM marketing.tracking_links WHERE id = :id AND deleted_at IS NULL`, { id }, transaction);
  return row || null;
}

/** Insere o link; short_code repetido (UNIQUE global) devolve null para o chamador sortear outro. */
async function insertLink(tenant, actor, v, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.tracking_links (id, group_id, company_id, campaign_id, content_item_id, short_code, target_url, utm_source, utm_medium,
        utm_campaign, utm_content, utm_term, channel, signature, expires_at, status, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :campaignId, :contentItemId, :shortCode, :targetUrl, :utmSource, :utmMedium, :utmCampaign,
        :utmContent, :utmTerm, :channel, :signature, :expiresAt, 'ACTIVE', :actor, :actor)
     ON CONFLICT (short_code) DO NOTHING RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, campaignId: v.campaignId || null, contentItemId: v.contentItemId || null,
      shortCode: v.shortCode, targetUrl: v.targetUrl, utmSource: v.utmSource, utmMedium: v.utmMedium, utmCampaign: v.utmCampaign,
      utmContent: v.utmContent || null, utmTerm: v.utmTerm || null, channel: v.channel, signature: v.signature, expiresAt: v.expiresAt || null,
      actor: actor || null },
    transaction
  );
  return row || null;
}

async function campaignOf(campaignId, transaction) {
  const [row] = await run('SELECT id, code FROM marketing.campaigns WHERE id = :campaignId AND deleted_at IS NULL', { campaignId }, transaction);
  return row || null;
}

async function contentItemExists(contentItemId, transaction) {
  return (await run('SELECT 1 AS ok FROM marketing.content_items WHERE id = :contentItemId AND deleted_at IS NULL', { contentItemId }, transaction)).length > 0;
}

module.exports = { resolveRouting, findByShortCode, findById, insertLink, campaignOf, contentItemExists };
