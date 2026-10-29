'use strict';

/**
 * M9-D694 (3.3) — verificação DETERMINÍSTICA do texto da NAY antes de gravar o briefing. Roda no servidor e o modelo não a desliga. Por item:
 *  (a) todo número citado casa, até a 2ª casa, com a entrada (groundingNumbers);
 *  (b) toda afirmação de causa (`tipoAfirmacao = CAUSA`) traz `fonteCausa` apontando para registros de causa que existem na entrada e cita
 *      "segundo o registro";
 *  (c) palavra de causalidade (parâmetro `analytics.brief.palavras_causalidade`) fora de uma afirmação de causa fundamentada reprova o item.
 * Item reprovado é removido por quem chama, que registra o motivo (`analytics.brief.item_blocked`).
 */
const { firstMismatch } = require('./groundingNumbers');
const { norm } = require('./brief.areas');

const CAUSE_CODE = 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED';
const NUMBER_CODE = 'ANALYTICS_BRIEF_NUMBER_MISMATCH';
const TEXT_FIELDS = ['fato', 'variacao', 'incerteza', 'acaoSugerida'];
const CITATION = 'segundo o registro';

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function causalWordIn(text, words) {
  const clean = norm(text).replace(/\s+/g, ' '); // espaço duplo ou quebra de linha entre as palavras não escapa da conferência
  return words.find((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}([^a-z0-9]|$)`).test(clean)) || null;
}

/** O item afirma causa com fonte? Cada id de `fonteCausa` precisa existir nos registros de causa da entrada. */
function causeGrounded(item, causeIds) {
  const refs = Array.isArray(item.fonteCausa) ? item.fonteCausa : [];
  return refs.length > 0 && refs.every((id) => causeIds.has(id));
}

/** @returns {{ ok: true } | { ok: false, code: string, reason: string }} */
function validateItem(item, { causeIds, allowed, words }) {
  const text = TEXT_FIELDS.map((f) => (typeof item[f] === 'string' ? item[f] : '')).join(' \n ');
  const claimsCause = item.tipoAfirmacao === 'CAUSA';
  const grounded = claimsCause && causeGrounded(item, causeIds) && norm(text).replace(/\s+/g, ' ').includes(CITATION);
  if (claimsCause && !grounded) {
    return { ok: false, code: CAUSE_CODE, reason: 'Afirmação de causa sem registro de causa existente na entrada (fonteCausa ausente ou desconhecida, ou sem a citação do registro).' };
  }
  const word = causalWordIn(text, words);
  if (word && !grounded) return { ok: false, code: CAUSE_CODE, reason: `Palavra de causalidade "${word}" fora de uma citação de registro de causa.` };
  const bad = firstMismatch(text, allowed);
  if (bad !== null) return { ok: false, code: NUMBER_CODE, reason: `O número "${bad}" não confere com os indicadores da entrada.` };
  return { ok: true };
}

module.exports = { validateItem, causalWordIn, CAUSE_CODE, NUMBER_CODE, TEXT_FIELDS };
