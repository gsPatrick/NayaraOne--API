'use strict';

/** M9-D431 — constantes da atribuição (MKT-012): único lugar com os catálogos fechados. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sem 0/O, 1/I/L (ambíguos)
const SHORT_CODE_LENGTH = 8;
const MAX_URL_LENGTH = 2048;
const EVENT_TYPES = Object.freeze(['CLICK', 'LEAD_CREATED', 'VISIT', 'PROPOSAL', 'SALE']);
const LEAD_SOURCES = Object.freeze(['FORM', 'WHATSAPP', 'PHONE', 'EMAIL', 'SITE', 'PORTAL', 'SOCIAL', 'REFERRAL', 'OTHER']);
const LINK_CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL']);
const MODELS = Object.freeze(['first', 'last']);
const UTM_FIELDS = Object.freeze(['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm']);
/** Chaves de evidência obrigatórias por tipo de evento (Caderno §13: "não atribuir venda a campanha sem evidência"). */
const EVIDENCE_REQUIRED = Object.freeze({
  CLICK: ['trackingLinkId'],
  LEAD_CREATED: ['opportunityId'],
  VISIT: ['visitId'],
  PROPOSAL: ['proposalId'],
  SALE: ['contractId', 'contractValue'],
});
const UNATTRIBUTED = 'NAO_ATRIBUIDA';

module.exports = {
  ALPHABET, SHORT_CODE_LENGTH, MAX_URL_LENGTH, EVENT_TYPES, LEAD_SOURCES, LINK_CHANNELS, MODELS, UTM_FIELDS, EVIDENCE_REQUIRED, UNATTRIBUTED,
};
