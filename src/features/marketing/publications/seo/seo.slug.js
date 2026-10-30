'use strict';

/**
 * M9-D427 — URL canônica do imóvel: `/imoveis/{finalidade}/{tipo}/{bairro-slug}/{slug}-{publicId}`. O publicId (uuid) é imutável e é ele que
 * resolve a página; o slug é só texto de apoio e pode mudar sem quebrar o link. O slug nasce de campos verdadeiros do cadastro (tipo,
 * quartos), nunca de texto livre do imóvel (título e descrição podem citar endereço ou dado interno).
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT = '/imoveis';

const FINALIDADE_SLUG = Object.freeze({ VENDA: 'venda', LOCACAO: 'locacao' });
const TYPE_LABEL = Object.freeze({ RESIDENTIAL: 'Imóvel residencial', COMMERCIAL: 'Imóvel comercial', LAND: 'Terreno', RURAL: 'Imóvel rural' });
const TYPE_SLUG = Object.freeze({ RESIDENTIAL: 'residencial', COMMERCIAL: 'comercial', LAND: 'terreno', RURAL: 'rural' });

/** Segmento de URL do tipo (tipos conhecidos em português; desconhecido vira slug do próprio valor). */
const typeSlug = (tipo) => TYPE_SLUG[String(tipo || '').toUpperCase()] || slugify(tipo) || 'imovel';

/** "Jardim Europa" -> "jardim-europa" (sem acento, minúsculas, hífen). Vazio vira null. */
function slugify(text) {
  const slug = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

const isPublicId = (value) => UUID_STRICT.test(String(value || ''));

/** Rótulo em português do tipo do imóvel (tipo desconhecido volta como veio, em minúsculas capitalizado). */
function typeLabel(tipo) {
  const key = String(tipo || '').toUpperCase();
  if (TYPE_LABEL[key]) return TYPE_LABEL[key];
  const text = String(tipo || '').trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

/** Slug da página: tipo + quartos (quando há). */
function pageSlug({ tipo, quartos }) {
  const base = typeSlug(tipo);
  return Number.isInteger(quartos) && quartos > 0 ? `${base}-${quartos}q` : base;
}

/** Caminho da listagem de um bairro/tipo (destino do 301). Sem bairro (endereço oculto), cai na listagem do tipo. */
function listingPath({ finalidade, tipo, bairro }) {
  const parts = [ROOT, FINALIDADE_SLUG[finalidade] || FINALIDADE_SLUG.VENDA, typeSlug(tipo)];
  if (slugify(bairro)) parts.push(slugify(bairro));
  return parts.join('/');
}

/** Caminho canônico da página do imóvel. */
function canonicalPath(page) {
  return `${listingPath(page)}${slugify(page.bairro) ? '' : '/todos-os-bairros'}/${pageSlug(page)}-${page.publicId}`;
}

/** O publicId que um caminho carrega (o uuid no fim do último segmento), ou null. */
function publicIdFromPath(path) {
  const last = String(path || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  const match = last.match(UUID_RE);
  return match && last.endsWith(match[0]) ? match[0].toLowerCase() : null;
}

module.exports = { slugify, typeSlug, isPublicId, typeLabel, pageSlug, listingPath, canonicalPath, publicIdFromPath, FINALIDADE_SLUG, ROOT };
