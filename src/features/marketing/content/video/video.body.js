'use strict';

const { assembleReel } = require('./video.assemble');
const { resolveMedia } = require('./video.resolve');
const { readVideoConfig } = require('./video.settings');
const { requiredNotices, withNotices, assertNotices, assertRenderPhrase } = require('./video.synthetic');
const { videoInvalid } = require('./video.errors');

const isVideo = (type) => type === 'VIDEO_REEL';
const captionsOf = (media) => ((media.transformLog || {}).operations || []).filter((o) => o.op === 'CAPTION').map((o) => o.text);

/**
 * Prepara a mídia do VIDEO_REEL antes de qualquer texto (M9-D426): `midiaId` OU `montagem` (a montagem gera o derivado e a mídia passa a ser ele). Mídia não autorizada
 * para o fluxo ANTES de a NAY ser chamada.
 */
async function prepareVideoMedia({ tenant, actor, input }, transaction) {
  if (input.montagem !== undefined && input.midiaId !== undefined) throw videoInvalid('Informe midiaId ou montagem, não os dois.', { field: 'montagem' });
  if (input.montagem !== undefined) {
    const { derivative } = await assembleReel({ tenant, actor, assembly: input.montagem }, transaction);
    return resolveMedia(derivative.id, transaction);
  }
  return resolveMedia(input.midiaId, transaction);
}

/**
 * Corpo da versão do reel: mídia resolvida, texto com os avisos de transparência que faltam (a política e os textos são parâmetros) e roteiro e descrição quando
 * houver. Renderização de projeto sem "Imagem ilustrativa" (na legenda do vídeo ou, mídia direta, no texto) é 422 MKT_SYNTHETIC_DISCLOSURE_REQUIRED.
 */
async function buildVideoBody({ tenant, media, texto, roteiro, descricao }, transaction) {
  const config = await readVideoConfig(tenant, transaction);
  const notices = media.sintetico ? requiredNotices(media.tiposSinteticos, config) : [];
  const hasText = typeof texto === 'string' && texto.trim() !== '';
  if (media.tipo === 'ORIGINAL' && hasText) assertRenderPhrase(media.tiposSinteticos, [texto, roteiro || '', descricao || ''], config);
  return {
    midiaId: media.derivadoId || media.arquivoId,
    midia: media,
    texto: hasText ? withNotices(texto, notices) : '',
    ...(roteiro ? { roteiro } : {}),
    ...(descricao ? { descricao } : {}),
  };
}

/**
 * Porta de transparência do passo de conformidade: versão de reel sintético precisa carregar os avisos exigidos pela política vigente e, se for renderização de projeto, a
 * expressão "Imagem ilustrativa". A versão é imutável: quem edita o texto por fora e tira o aviso para aqui (422 MKT_SYNTHETIC_DISCLOSURE_REQUIRED).
 */
async function assertVideoDisclosure({ tenant, item, version }, transaction) {
  if (!item || !isVideo(item.type)) return;
  const media = (version.body_json || {}).midia;
  if (!media || !media.sintetico) return;
  const config = await readVideoConfig(tenant, transaction);
  const texto = version.body_json.texto || '';
  assertNotices(texto, requiredNotices(media.tiposSinteticos, config));
  assertRenderPhrase(media.tiposSinteticos, media.tipo === 'DERIVADO' ? captionsOf(media) : [texto], config);
}

module.exports = { isVideo, prepareVideoMedia, buildVideoBody, assertVideoDisclosure };
