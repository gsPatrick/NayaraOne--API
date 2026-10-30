'use strict';

const { EmailMessage } = require('../../../../models');
const { LINK_KINDS } = require('./inbound.constants');

/** Resolvedores de referência por prefixo (`[PROC-1234]`): módulo de negócio que conhece a entidade registra o seu. `fn(ctx, número, transaction) -> { entityType, entityId } | null`. */
const resolvers = new Map();
const registerInboundReferenceResolver = (prefix, fn) => { resolvers.set(String(prefix).toUpperCase(), fn); return () => resolvers.delete(String(prefix).toUpperCase()); };

/** Resolvedor padrão: a entidade de origem do último e-mail que o sistema enviou citando esse número (origin_id). Referência que ninguém enviou não vincula. */
async function byOutboundOrigin(ctx, numero, transaction) {
  const enviada = await EmailMessage.findOne({ where: { companyId: ctx.companyId, originId: String(numero).slice(0, 64) }, order: [['created_at', 'DESC']], transaction });
  return enviada && enviada.originType ? { entityType: enviada.originType, entityId: enviada.originId, emailMessageId: enviada.id } : null;
}

/** `In-Reply-To`/`References`: <id@dominio> -> candidatos de identificador do provedor (com e sem o domínio). */
const candidatesOf = (valor) => [...new Set(String(valor || '').split(/\s+/).map((x) => x.replace(/^<|>$/g, '')).filter(Boolean).flatMap((x) => [x, x.split('@')[0]]))].slice(0, 20);

async function linkByReply(ctx, connectionId, inReplyTo, transaction) {
  const ids = candidatesOf(inReplyTo);
  for (const id of ids) {
     
    const enviada = await EmailMessage.findOne({ where: { companyId: ctx.companyId, connectionId, externalMessageId: id }, transaction });
    if (enviada && enviada.originType && enviada.originId) return { kind: LINK_KINDS.REPLY, entityType: enviada.originType, entityId: enviada.originId, emailMessageId: enviada.id };
  }
  return null;
}

async function linkByReference(ctx, assunto, prefixes, transaction) {
  const re = /\[([A-Za-z0-9]{2,12})-([A-Za-z0-9_.-]{1,60})\]/g;
  for (const m of String(assunto || '').matchAll(re)) {
    const prefixo = m[1].toUpperCase();
    if (!prefixes.includes(prefixo)) continue;
     
    const r = await (resolvers.get(prefixo) || byOutboundOrigin)(ctx, m[2], transaction);
    if (r) return { kind: LINK_KINDS.REFERENCE, entityType: r.entityType, entityId: String(r.entityId), emailMessageId: r.emailMessageId || null };
  }
  return null;
}

/** Vínculo da mensagem recebida (M9-D235 3.1 item 4): primeiro a resposta (`In-Reply-To`/`References`), depois a referência no assunto; sem nenhum, `null` (não vinculada). */
async function resolveLink(ctx, { connectionId, inReplyTo, subject, prefixes }, transaction) {
  return (await linkByReply(ctx, connectionId, inReplyTo, transaction)) || (await linkByReference(ctx, subject, prefixes, transaction));
}

module.exports = { resolveLink, registerInboundReferenceResolver, candidatesOf };
