'use strict';

const crypto = require('node:crypto');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./tracking.links.repository');
const signing = require('./tracking.signing');
const { assertAllowedUrl } = require('./tracking.url');
const { ALPHABET, SHORT_CODE_LENGTH, LINK_CHANNELS, UTM_FIELDS } = require('./tracking.catalog');
const { invalidInput, notFound } = require('./tracking.errors');

const FIELDS = ['targetUrl', 'channel', 'campaignId', 'contentItemId', 'expiresAt', ...UTM_FIELDS];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIUM_BY_CHANNEL = Object.freeze({ EMAIL: 'email', WHATSAPP: 'mensagem', SITE: 'site', PORTAL: 'portal' });

const hasControlChar = (text) => [...text].some((ch) => ch.charCodeAt(0) < 32);

function newShortCode() {
  let out = '';
  for (const byte of crypto.randomBytes(SHORT_CODE_LENGTH)) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput('Corpo da requisição inválido.');
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k));
  if (unknown.length > 0) throw invalidInput(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
  const channel = typeof input.channel === 'string' ? input.channel.trim().toUpperCase() : '';
  if (!LINK_CHANNELS.includes(channel)) throw invalidInput('Informe um canal válido para o link.', { field: 'channel', allowed: LINK_CHANNELS });
  for (const f of ['campaignId', 'contentItemId']) {
    if (input[f] !== undefined && input[f] !== null && !UUID_RE.test(String(input[f]))) throw invalidInput(`Dados inválidos: ${f}.`, { field: f });
  }
  for (const f of UTM_FIELDS) {
    const v = input[f];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !v.trim() || v.length > 200 || hasControlChar(v))) throw invalidInput(`Dados inválidos: ${f}.`, { field: f });
  }
  let expiresAt = null;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw invalidInput('A expiração do link deve ser uma data futura.', { field: 'expiresAt' });
  }
  return { ...input, channel, expiresAt };
}

const dto = (row) => ({
  id: row.id, shortCode: row.short_code, path: `/t/${row.short_code}`, targetUrl: row.target_url, channel: row.channel, status: row.status,
  campaignId: row.campaign_id, contentItemId: row.content_item_id, expiresAt: row.expires_at,
  utm: { source: row.utm_source, medium: row.utm_medium, campaign: row.utm_campaign, content: row.utm_content, term: row.utm_term },
});

/**
 * POST /marketing/tracking-links — gera o código curto (8 caracteres sem ambiguidade, UNIQUE), valida a URL de destino, completa as
 * UTMs (origem = canal, mídia pelo canal, campanha = código da campanha) e assina `short_code + target_url` com a chave do cofre.
 */
async function createTrackingLink({ tenant, actor, input, system = false }, transaction) {
  const data = parseInput(input);
  let campaign = null;
  if (data.campaignId) {
    campaign = await repo.campaignOf(data.campaignId, transaction);
    if (!campaign) throw notFound('Campanha não encontrada.');
  }
  if (data.contentItemId && !(await repo.contentItemExists(data.contentItemId, transaction))) throw notFound('Conteúdo não encontrado.');
  const targetUrl = await assertAllowedUrl(data.targetUrl, { tenant, transaction, origin: system ? 'SYSTEM' : 'USER' }); // `system` só vem de código do servidor (automações), nunca do corpo do pedido
  const utm = {
    utmSource: data.utmSource || data.channel.toLowerCase(),
    utmMedium: data.utmMedium || MEDIUM_BY_CHANNEL[data.channel] || 'social',
    utmCampaign: data.utmCampaign || (campaign ? campaign.code.toLowerCase() : 'sem-campanha'),
    utmContent: data.utmContent, utmTerm: data.utmTerm,
  };
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
    const shortCode = newShortCode();
    const signature = await signing.signLink(tenant.companyId, shortCode, targetUrl);
    row = await repo.insertLink(tenant, actor, { ...utm, shortCode, targetUrl, channel: data.channel, signature, expiresAt: data.expiresAt, campaignId: data.campaignId, contentItemId: data.contentItemId }, transaction);
  }
  if (!row) throw invalidInput('Não foi possível gerar um código único; tente novamente.');
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.tracking_link.create', entityType: 'marketing.tracking_link',
    entityId: row.id, beforeJson: null, afterJson: { shortCode: row.short_code, channel: row.channel, campaignId: row.campaign_id, targetHost: new URL(targetUrl).hostname },
    reason: 'Link de rastreio criado.',
  }, transaction);
  return dto(row);
}

/** Token `r` do link enviado em UMA mensagem (usado pelos canais, M9-D429): contém só o id da mensagem em crm.messages. */
async function createMessageToken(tenant, linkId, messageId) {
  return signing.signMessageToken(tenant.companyId, linkId, messageId);
}

module.exports = { createTrackingLink, createMessageToken, newShortCode, dto };
