'use strict';

/** Catálogos fechados dos templates (iguais aos CHECKs de marketing.templates, migration 20260101000750). */
const TEMPLATE_CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL']);
const TEMPLATE_KINDS = Object.freeze(['CONTENT', 'MESSAGE']);
const TEMPLATE_STATUSES = Object.freeze(['DRAFT', 'PUBLISHED', 'RETIRED']);
/** Tipos aceitos para cada placeholder {{nome}} declarado em variables_json. */
const VARIABLE_TYPES = Object.freeze(['text', 'number', 'money', 'date', 'url']);

const TEMPLATE_MANAGE_PERMISSION = 'marketing:template:manage';
const CONTENT_READ_PERMISSION = 'marketing:content:read';

module.exports = {
  TEMPLATE_CHANNELS, TEMPLATE_KINDS, TEMPLATE_STATUSES, VARIABLE_TYPES, TEMPLATE_MANAGE_PERMISSION, CONTENT_READ_PERMISSION,
};
