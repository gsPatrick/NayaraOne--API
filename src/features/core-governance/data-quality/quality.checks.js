'use strict';

const { isValidTaxIdDigits, onlyDigits } = require('../../people/personDocumentFormat.service');

/**
 * Verificações das regras de qualidade (M9-D806 §3.1): cada uma é função pura de (contexto do cadastro, configuração) e devolve verdadeiro quando a
 * regra PASSA. O nome da verificação é o que a coluna `expression` de governance.quality_rules guarda: nunca SQL livre.
 * Contexto: { person | property, contacts, address, roles, owners, offers, media, banks, qualification } (quality.loader.js). Configuração: { today,
 * addressFields, mediaMin, qualificationCategories }.
 */
const filled = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const digitsOf = (value) => (filled(value) ? onlyDigits(String(value)) : '');

const addressComplete = (address, fields) => Boolean(address) && fields.every((field) => filled(address[field]));

const CHECKS = Object.freeze({
  taxIdPresent: (ctx) => digitsOf(ctx.person.tax_id_normalized) !== '',
  taxIdValid: (ctx) => isValidTaxIdDigits(digitsOf(ctx.person.tax_id_normalized)),
  contactPresent: (ctx) => ctx.contacts > 0,
  personAddressComplete: (ctx, cfg) => addressComplete(ctx.address, cfg.addressFields),
  birthCoherent: (ctx, cfg) => {
    const date = ctx.person.birth_or_foundation_date;
    return filled(date) && String(date).slice(0, 10) < cfg.today;
  },
  nameWithoutDigits: (ctx) => !/\d/.test(String(ctx.person.legal_name || '')),
  roleDefined: (ctx) => ctx.roles > 0,
  registryPresent: (ctx) => filled(ctx.property.registry_number),
  propertyAddressComplete: (ctx, cfg) => addressComplete(ctx.address, cfg.addressFields),
  ownerLinked: (ctx) => ctx.owners > 0,
  areaPositive: (ctx) => Number(ctx.property.area_total_m2) > 0,
  purposeDefined: (ctx) => ctx.offers > 0,
  mediaMinimum: (ctx, cfg) => ctx.media >= cfg.mediaMin,
  bankValidated: (ctx) => ctx.banks > 0,
  categoryDefined: (ctx) => filled(ctx.category),
  qualificationValid: (ctx, cfg) => {
    const q = ctx.qualification;
    if (!q || !(q.document_count > 0) || !q.valid_until || String(q.valid_until).slice(0, 10) < cfg.today) return false;
    return !q.high_risk || q.due_diligence_status === 'APPROVED';
  },
});

/** Condições de aplicabilidade (`applies_when`). */
const APPLIES = Object.freeze({
  isIndividual: (ctx) => ctx.person.person_type === 'PF',
  categoryRequiresQualification: (ctx, cfg) => cfg.qualificationCategories === '*' || cfg.qualificationCategories.includes(String(ctx.category || '').toUpperCase()),
});

module.exports = { CHECKS, APPLIES };
