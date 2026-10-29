'use strict';

const crypto = require('node:crypto');
const { sequelize } = require('../../../models');
const linksRepo = require('./tracking.links.repository');
const eventsRepo = require('./tracking.events.repository');
const signing = require('./tracking.signing');
const { recordEvent } = require('./tracking.events.service');
const { withUtms } = require('./tracking.url');
const { linkNotFound } = require('./tracking.errors');

const SHORT_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MINUTE_MS = 60000;
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Abre a sessão do tenant do link (a rota é pública: o tenant vem do link, nunca do chamador). */
async function inTenantTransaction(routing, fn, outer) {
  const body = async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)",
      { replacements: { g: routing.group_id, c: routing.company_id }, transaction });
    return fn(transaction);
  };
  return outer ? body(outer) : sequelize.transaction(body); // `outer` só nos testes (transação com rollback)
}

/** Link vigente: ACTIVE, não expirado. Qualquer outra coisa é "link inválido" (404), sem pista do motivo. */
function isUsable(link, now) {
  return link.status === 'ACTIVE' && (!link.expires_at || new Date(link.expires_at) > now);
}

/**
 * Clique identificado SÓ com o token `r` válido para ESTE link E consentimento do canal da mensagem (MARKETING). Sem `r`, `r` inválido,
 * mensagem de outra pessoa/empresa ou sem consentimento: clique anônimo (person_id nulo), que nunca é toque.
 */
async function identifyClick(routing, link, token, transaction) {
  if (!token) return null;
  const messageId = await signing.verifyMessageToken(routing.company_id, link.id, token);
  if (!messageId) return null;
  const message = await eventsRepo.findMessage(messageId, transaction);
  if (!message || !message.person_id) return null;
  const { canContact } = require('../../../features/people/personConsents.service');
  if (!(await canContact({ id: message.person_id }, message.channel, 'MARKETING', transaction))) return null;
  return { personId: message.person_id, messageId };
}

/**
 * GET /t/:shortCode (pública): confere a assinatura (adulterado = 404 e NADA é registrado), registra o CLICK (um por link, sessão e
 * minuto) e devolve a URL final com as UTMs para o 302. `session` = { ip, userAgent }: só o hash dos dois é guardado.
 */
async function resolveClick({ shortCode, token, session, now = new Date(), transaction: outer }) {
  if (!SHORT_CODE_RE.test(String(shortCode || ''))) throw linkNotFound();
  const routing = await linksRepo.resolveRouting(shortCode, outer);
  if (!routing) throw linkNotFound();
  return inTenantTransaction(routing, async (transaction) => {
    const link = await linksRepo.findByShortCode(shortCode, transaction);
    if (!link || !isUsable(link, now) || !(await signing.verifyLink(routing.company_id, link))) throw linkNotFound();
    const tenant = { groupId: routing.group_id, companyId: routing.company_id };
    const identified = await identifyClick(routing, link, token, transaction);
    const sessionHash = sha(`${(session && session.ip) || ''}|${(session && session.userAgent) || ''}`);
    const bucket = Math.floor(now.getTime() / MINUTE_MS);
    await recordEvent({
      tenant, actor: null, eventType: 'CLICK', personId: identified ? identified.personId : null, campaignId: link.campaign_id, trackingLinkId: link.id,
      occurredAt: now, sessionHash, dedupeKey: `click:${link.id}:${identified ? identified.personId : sessionHash}:${bucket}`,
      evidence: { trackingLinkId: link.id, shortCode: link.short_code, identified: Boolean(identified), ...(identified ? { messageId: identified.messageId } : { sessionHash }) },
    }, transaction);
    return { location: withUtms(link.target_url, link) };
  }, outer);
}

module.exports = { resolveClick, isUsable };
