'use strict';

const { syntheticDisclosureRequired, videoInvalid } = require('./video.errors');
const { SYNTHETIC_KINDS } = require('./video.settings');

/**
 * M9-D426 regra 4 — conteúdo sintético e transparência. Elementos sintéticos relevantes (voz, avatar, cena renderizada, renderização ou ilustração de projeto) marcam o
 * vídeo `synthetic = true` com os tipos; a política (parâmetro) decide quais pedem aviso e os textos são os dos parâmetros. Renderização de obra leva ainda a expressão
 * "Imagem ilustrativa" (parâmetro), que a montagem exige na legenda do próprio vídeo.
 */
const PROJECT_KINDS = Object.freeze(['RENDER', 'ILLUSTRATION']);
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const includesText = (haystack, needle) => fold(haystack).includes(fold(needle));

/** Lista de tipos sintéticos informada na requisição: [{kind}] ou ['VOICE']; tipo fora do catálogo é 400. */
function parseSyntheticElements(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw videoInvalid('Dados inválidos: elementosSinteticos.', { field: 'elementosSinteticos' });
  const kinds = value.map((item) => String(item && typeof item === 'object' ? item.kind : item || '').trim().toUpperCase());
  const bad = kinds.filter((k) => !SYNTHETIC_KINDS.includes(k));
  if (bad.length) throw videoInvalid('Tipo de elemento sintético desconhecido.', { field: 'elementosSinteticos', validos: SYNTHETIC_KINDS });
  return [...new Set(kinds)];
}

/** Avisos que o conteúdo precisa carregar, pela política: SEMPRE (qualquer sintético) ou POR_TIPO (só os tipos escolhidos). */
function requiredNotices(kinds, config) {
  const relevant = config.policy === 'POR_TIPO' ? kinds.filter((k) => config.noticeKinds.includes(k)) : kinds;
  const notices = relevant.map((k) => (PROJECT_KINDS.includes(k) ? config.noticeProject : config.noticeAi));
  return [...new Set(notices)];
}

/** Acrescenta ao fim do texto os avisos que faltam (nunca duplica, nunca remove nada do que a pessoa escreveu). */
function withNotices(textValue, notices) {
  const base = String(textValue || '').trim();
  const missing = notices.filter((n) => !includesText(base, n));
  return missing.length ? [base, ...missing].filter(Boolean).join('\n\n') : base;
}

function assertNotices(textValue, notices) {
  const missing = notices.filter((n) => !includesText(textValue, n));
  if (missing.length) throw syntheticDisclosureRequired({ reason: 'NOTICE_MISSING', missing });
}

/** Renderização de projeto precisa da expressão "Imagem ilustrativa" nas legendas do vídeo (ou, mídia direta, no texto). */
function assertRenderPhrase(kinds, captions, config) {
  if (!kinds.includes('RENDER')) return;
  if (!captions.some((c) => includesText(c, config.phrase))) throw syntheticDisclosureRequired({ reason: 'ILLUSTRATIVE_PHRASE_MISSING', required: config.phrase });
}

module.exports = { PROJECT_KINDS, parseSyntheticElements, requiredNotices, withNotices, assertNotices, assertRenderPhrase, includesText };
