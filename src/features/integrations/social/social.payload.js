'use strict';

const MODES = Object.freeze(['MANUAL', 'AUTO']);
const PREFIX = 'mkt';

/**
 * Referência do conteúdo que viaja no envio (`contentRef`): mkt:{item}:{versão}:{hash aprovado}:{modo}. O hash é o da versão APROVADA no
 * momento de enfileirar; o worker o confere de novo antes de chamar a rede (conteúdo editado depois da aprovação não sai).
 */
const formatContentRef = ({ itemId, versionId, approvedHash, mode }) => [PREFIX, itemId, versionId, approvedHash, mode].join(':');

function parseContentRef(ref) {
  const partes = String(ref || '').split(':');
  if (partes.length !== 5 || partes[0] !== PREFIX || !MODES.includes(partes[4])) return null;
  const [, itemId, versionId, approvedHash, mode] = partes;
  return { itemId, versionId, approvedHash, mode };
}

/** Pedido do port SocialAdapter.publishPost: texto aprovado, mídia autorizada e horário (o worker só o pega a partir dele). */
function buildPostPayload({ version, contentRef, scheduledAt }) {
  const body = version.body_json || {};
  return {
    contentRef,
    text: String(body.texto || ''),
    ...(body.midiaId ? { mediaRefs: [String(body.midiaId)] } : {}),
    ...(scheduledAt instanceof Date ? { scheduledAt: scheduledAt.toISOString() } : {}),
  };
}

module.exports = { formatContentRef, parseContentRef, buildPostPayload, MODES };
