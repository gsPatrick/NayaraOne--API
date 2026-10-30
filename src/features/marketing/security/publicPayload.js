'use strict';

const { mktError } = require('../marketing.errors');

/**
 * M9-D440 (guard_public_payload_only) — PublicPayload: o objeto que passou pelo `sanitizePublicFields` (M9-D403) e só ele. A marca vive num WeakSet do processo, então uma cópia
 * (`{ ...payload }`, JSON.parse) perde a marca e um DTO interno (imóvel com ocorrência, proprietário, documento) nunca ganha a marca por acidente: o único jeito de obtê-la é sanitizar.
 * Os canais de PUBLICAÇÃO (site, redes sociais, portal) só aceitam PublicPayload; mensagem direta a uma pessoa (WhatsApp, e-mail) leva o texto da própria mensagem e não passa por aqui.
 */
const MARKED = new WeakSet();

/** Marca o objeto sanitizado como PublicPayload e o devolve. Só o sanitizePublicFields chama. */
function markPublicPayload(payload) {
  if (payload !== null && typeof payload === 'object') MARKED.add(payload);
  return payload;
}

const isPublicPayload = (payload) => payload !== null && typeof payload === 'object' && MARKED.has(payload);

/** 422 MKT_INTERNAL_DTO_FORBIDDEN quando o que chega ao canal público não é um PublicPayload. Nada sai. */
function assertPublicPayload(payload, channel) {
  if (isPublicPayload(payload)) return payload;
  throw mktError(422, 'MKT_INTERNAL_DTO_FORBIDDEN', 'Um objeto interno foi entregue a um canal público: só o conteúdo sanitizado pode sair.', { channel });
}

module.exports = { markPublicPayload, isPublicPayload, assertPublicPayload };
