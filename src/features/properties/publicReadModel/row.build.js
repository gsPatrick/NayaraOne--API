'use strict';

const crypto = require('node:crypto');
const { redactFreeText, REMOVED } = require('../../../shared/redaction');
const { approximateCoordinate, exactCoordinate } = require('./geo.approximate');
const { publicFeatures, numberAttr } = require('./publicFeatures');
const { PURPOSE_SALE, PURPOSE_RENT } = require('./constants');

// O cadastro grava foto como PHOTO (migration 80); IMAGE é o nome que a validação do serviço de mídia aceita.
const PHOTO_TYPES = ['PHOTO', 'IMAGE'];
const money = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));
const intOrNull = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Math.round(Number(value)) : null);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** O nome inteiro e cada trecho de 2 ou mais palavras seguidas dele (quem escreve "Maria Souza" para "Maria Souza Lima" também é pego). */
function nameVariants(name) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return [words[0]];
  const out = [];
  for (let size = words.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) out.push(words.slice(start, start + size).join(' '));
  }
  return out;
}

/** Texto público: PII pela biblioteca e o nome de cada proprietário removido (M9-D231 regra 3). */
function publicText(text, ownerNames) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let out = redactFreeText(text);
  const variants = [...new Set(ownerNames.flatMap(nameVariants))].sort((a, b) => b.length - a.length);
  variants.forEach((name) => { out = out.replace(new RegExp(escapeRe(name), 'gi'), REMOVED); });
  return out.trim() || null;
}

/** Endereço público conforme a visibilidade: RESTRICTED só bairro/cidade/UF e sem coordenada; APPROXIMATE desloca; PUBLIC ponto exato. */
function publicLocation(property, address, radiusM) {
  const base = {
    neighborhood: address ? address.neighborhood : null,
    city: (address && address.city) || property.city || null,
    state: (address && address.state) || property.state || null,
    lat_lng_public: null,
  };
  if (property.addressVisibility === 'APPROXIMATE') base.lat_lng_public = approximateCoordinate(property.latitude, property.longitude, property.id, radiusM);
  else if (property.addressVisibility === 'PUBLIC') base.lat_lng_public = exactCoordinate(property.latitude, property.longitude);
  return base;
}

function pickOffer(offers) {
  const sale = offers.find((o) => o.offerType === 'SALE');
  if (sale) return { offer: sale, purpose: PURPOSE_SALE };
  const rent = offers.find((o) => o.offerType === 'RENT');
  return rent ? { offer: rent, purpose: PURPOSE_RENT } : { offer: null, purpose: null };
}

const documentAmount = (documents, type) => {
  const doc = documents.find((d) => d.documentType === type && d.valueAmount !== null && d.valueAmount !== undefined);
  return doc ? money(doc.valueAmount) : null;
};

/** Só arquivo PUBLIC e CLEAN entra; foto REJECTED fica de fora (DI-D231-3). Devolve os ids dos arquivos, na ordem do cadastro. */
const publicMedia = (media, cleanKeys, types) => media.filter((m) => types.includes(m.mediaType) && m.classification === 'PUBLIC' && m.qualityStatus !== 'REJECTED' && cleanKeys.has(m.storageKey));

const httpsUrl = (value) => (typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value.trim()) ? value.trim() : null);

/** Código público estável, derivado do identificador opaco público (nunca do código interno). */
const publicCode = (property) => `IMV-${String(property.publicId).replace(/-/g, '').slice(0, 10).toUpperCase()}`;

/** Monta o registro do read model (os 21 campos de dado; a versão é do banco). */
function buildPublicRow(source, { radiusM }) {
  const { property, address, offers, documents, media, cleanKeys, ownerNames } = source;
  const attrs = property.attributesJson && typeof property.attributesJson === 'object' ? property.attributesJson : {};
  const { offer, purpose } = pickOffer(offers);
  const row = {
    public_code: publicCode(property),
    title: publicText(property.title, ownerNames) || publicCode(property),
    description_public: publicText(property.descriptionPublic, ownerNames),
    purpose,
    type: property.propertyType,
    price_public: money(offer && offer.askingPrice),
    condo_fee_public: documentAmount(documents, 'CONDO_FEE'),
    iptu_public: documentAmount(documents, 'IPTU'),
    area_total: property.areaTotalM2 === null || property.areaTotalM2 === undefined ? null : Number(Number(property.areaTotalM2).toFixed(2)),
    area_built: numberAttr(attrs, 'usableAreaM2'),
    bedrooms: intOrNull(property.bedrooms),
    bathrooms: intOrNull(numberAttr(attrs, 'bathrooms')),
    parking_spots: intOrNull(property.parkingSpots),
    ...publicLocation(property, address, radiusM),
    photos_public: publicMedia(media, cleanKeys, PHOTO_TYPES).map((m) => m.id),
    video_public_url: httpsUrl(attrs.videoPublicUrl),
    features_public: publicFeatures(attrs),
    published_at: property.publishedAt ? new Date(property.publishedAt).toISOString() : null,
  };
  return row;
}

/** Hash do conteúdo público: muda quando (e só quando) algum campo público muda. */
const contentHash = (row) => crypto.createHash('sha256').update(JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]))).digest('hex');

module.exports = { buildPublicRow, contentHash, publicCode, publicText };
