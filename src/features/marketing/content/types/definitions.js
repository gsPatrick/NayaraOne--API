'use strict';

/**
 * M9-D409 — os 10 tipos de conteúdo do Marketing. Cada tipo declara em código a ContentTypeDefinition do livro:
 * { type, requiredFields, allowedChannels, sourceLoader, sanitizerProfile, defaultTemplateCode } e, para o gatilho, o evento que
 * gera o rascunho. `requiredFields` separa o que vem na requisição (input) do que vem dos fatos da fonte (facts); "a|b" = qualquer
 * um dos dois. `sourceLoader` diz de onde vêm os fatos: property e construction (read models públicos), person (fatos de
 * relacionamento, canal privado) ou none (conteúdo humano, sem fonte). `sanitizerProfile`: public (passa pela allowlist pública),
 * private (dado pessoal, só canal privado sujeito a canSend) ou human (texto escrito por pessoa, só varredura de PII).
 */
const PRIVATE_CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL']);
const SOCIAL_CHANNELS = Object.freeze(['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK']);
const WEB_CHANNELS = Object.freeze(['SITE', 'PORTAL']);
const ALL_CHANNELS = Object.freeze([...WEB_CHANNELS, ...SOCIAL_CHANNELS, ...PRIVATE_CHANNELS]);
const PUBLIC_CHANNELS = Object.freeze([...WEB_CHANNELS, ...SOCIAL_CHANNELS]);

const PROPERTY_FACTS = ['tipo', 'finalidade', 'bairro', 'precoVenda|precoLocacao', 'quartos', 'fotosAutorizadas'];

const def = (value) => Object.freeze({
  ...value,
  requiredFields: Object.freeze({ input: Object.freeze([...value.requiredFields.input]), facts: Object.freeze([...value.requiredFields.facts]) }),
  allowedChannels: Object.freeze([...value.allowedChannels]),
});

const DEFINITIONS = Object.freeze({
  NEW_PROPERTY: def({
    type: 'NEW_PROPERTY', sourceLoader: 'property', sanitizerProfile: 'public', defaultTemplateCode: 'NEW_PROPERTY_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: PROPERTY_FACTS }, allowedChannels: ALL_CHANNELS, trigger: 'property.published',
  }),
  PRICE_REDUCTION: def({
    type: 'PRICE_REDUCTION', sourceLoader: 'property', sanitizerProfile: 'public', defaultTemplateCode: 'PRICE_REDUCTION_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: ['precoAnterior', 'precoVenda|precoLocacao', 'bairro'] }, allowedChannels: ALL_CHANNELS,
    trigger: 'property.price.changed',
  }),
  SOLD_RENTED: def({
    type: 'SOLD_RENTED', sourceLoader: 'property', sanitizerProfile: 'public', defaultTemplateCode: 'SOLD_RENTED_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: ['tipo', 'bairro', 'status'] }, allowedChannels: PUBLIC_CHANNELS, trigger: 'property.sold|property.rented',
  }),
  NAYARA_CONSTRUCTION: def({
    type: 'NAYARA_CONSTRUCTION', sourceLoader: 'construction', sanitizerProfile: 'public', defaultTemplateCode: 'NAYARA_CONSTRUCTION_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: ['nomeEmpreendimento', 'etapaPublica', 'fotosAutorizadas'] }, allowedChannels: ALL_CHANNELS,
    trigger: 'marco público da obra',
  }),
  INSTITUTIONAL: def({
    type: 'INSTITUTIONAL', sourceLoader: 'none', sanitizerProfile: 'human', defaultTemplateCode: 'INSTITUTIONAL_DEFAULT',
    requiredFields: { input: ['title', 'texto'], facts: [] }, allowedChannels: [...PUBLIC_CHANNELS, 'EMAIL'], trigger: 'manual',
  }),
  EDUCATIONAL_BLOG: def({
    type: 'EDUCATIONAL_BLOG', sourceLoader: 'none', sanitizerProfile: 'human', defaultTemplateCode: 'EDUCATIONAL_BLOG_DEFAULT',
    requiredFields: { input: ['tema', 'fontes'], facts: [] }, allowedChannels: ['SITE', ...SOCIAL_CHANNELS, 'EMAIL'], trigger: 'manual ou agenda',
  }),
  POST_SALE: def({
    type: 'POST_SALE', sourceLoader: 'person', sanitizerProfile: 'private', defaultTemplateCode: 'POST_SALE_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: ['primeiroNome', 'marco'] }, allowedChannels: PRIVATE_CHANNELS, trigger: 'keys.delivered',
  }),
  BIRTHDAY_RELATIONSHIP: def({
    type: 'BIRTHDAY_RELATIONSHIP', sourceLoader: 'person', sanitizerProfile: 'private', defaultTemplateCode: 'BIRTHDAY_RELATIONSHIP_DEFAULT',
    requiredFields: { input: ['sourceEntityId'], facts: ['primeiroNome', 'dia', 'mes'] }, allowedChannels: PRIVATE_CHANNELS, trigger: 'job diário',
  }),
  SEGMENTED_CAMPAIGN: def({
    type: 'SEGMENTED_CAMPAIGN', sourceLoader: 'none', sanitizerProfile: 'human', defaultTemplateCode: 'SEGMENTED_CAMPAIGN_DEFAULT',
    requiredFields: { input: ['campaignId', 'channels', 'templateId|templateCode'], facts: [] }, allowedChannels: PRIVATE_CHANNELS, trigger: 'passo da campanha',
  }),
  VIDEO_REEL: def({
    type: 'VIDEO_REEL', sourceLoader: 'none', sanitizerProfile: 'human', defaultTemplateCode: 'VIDEO_REEL_DEFAULT',
    requiredFields: { input: ['midiaId', 'texto'], facts: [] }, allowedChannels: ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN', 'SITE'], trigger: 'manual ou NAY',
  }),
});

/** Tipo de fonte (sourceEntityType) que cada carregador aceita. */
const SOURCE_ENTITY_OF_LOADER = Object.freeze({ property: 'property', construction: 'construction', person: 'person', none: null });

module.exports = { DEFINITIONS, SOURCE_ENTITY_OF_LOADER, PRIVATE_CHANNELS, PUBLIC_CHANNELS, ALL_CHANNELS };
