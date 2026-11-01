'use strict';

const { WORD_PATTERN, fold } = require('./text');
const { parseTerms, DEFAULT_LEGAL_REFS } = require('./settings');
const { finding } = require('./finding');
const { rx } = require('../../../../shared/redaction');
const { derivedNumbersFromFacts } = require('../types/derivedNumbers');

const MONTHS = Object.freeze(['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']);
const PHONE = /(?<!\d)(?:\+?55\s*)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}(?!\d)/g;
const DATE_NUMERIC = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g;
const DATE_WORDS = new RegExp(`(?<!\\d)(\\d{1,2})\\s+de\\s+(${MONTHS.join('|')})(?:\\s+de\\s+(\\d{4}))?`, 'g');
const WORD_UNITS = new RegExp(`\\b(?:${WORD_PATTERN.replace('um|uma|', '')}|trinta|quarenta|cinquenta|sessenta|cem|mil)\\s+(?:minutos?|metros?|quilometros?|km|andares?|anos?|unidades?|pavimentos?|horas?|dias?|torres?|apartamentos?|casas?)\\b`, 'g');
const YEAR = /^(?:19|20)\d{2}$/;
const TOKEN = /(?<![\d.,])\d+(?:[.,]\d+)*/g;
const SUPERLATIVE = /\b(?:o|a|os|as)\s+(?:maior|menor|melhor|pior|mais\s+[a-z]+|unico|unica)\b(?:\s+\w+){0,4}?\s+(?:d[aeo]s?|em|entre)\b/g;

const unexplained = (claim, message) => finding({ kind: 'UNKNOWN_CLAIM', claim, found: claim, reason: 'UNEXPLAINED', message });

/** Dia, mês e ano da data do conteúdo ({day, month, year} ou Date em UTC); null quando não informada. */
function contentParts(date) {
  if (!date) return null;
  if (date instanceof Date) return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
  return date;
}

function isContentDate(parts, day, month, year) {
  if (!parts) return false;
  const y = year === undefined || year === null || year === '' ? null : Number(year) % (String(year).length === 2 ? 100 : 10000);
  const yearOk = y === null || y === (String(year).length === 2 ? parts.year % 100 : parts.year);
  return Number(day) === parts.day && Number(month) === parts.month && yearOk;
}

function phoneAllowed(digits, allowed) {
  const national = digits.replace(/^55(?=\d{10,11}$)/, '');
  return allowed.some((p) => p.endsWith(national) || national.endsWith(p));
}

const escapeRegex = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Decreto 10.123/19", "Lei nº 8.245/91", "CRECI 12345": palavra da lista (parâmetro) + número de documento. Sem palavra da lista o número segue sendo conferido. */
function legalReferenceRegex(words) {
  const list = words.map((w) => escapeRegex(fold(w)).replace(/\s+/g, '\\s+')).filter(Boolean);
  return list.length === 0 ? null : new RegExp(`\\b(?:${list.join('|')})\\b\\.?\\s*(?:n[o\u00ba\u00b0.]{0,2}\\s*)?\\d[\\d./-]*`, 'g');
}

/** Ordem importa: telefone e data antes dos números soltos, para um trecho não ser lido duas vezes. */
function numericClaims(doc, options, facts) {
  const derived = derivedNumbersFromFacts(facts); // M9-D409: percentual da redução calculado dos fatos
  const findings = [];
  const parts = contentParts(options.contentDate);
  const take = (regex, explained) => {
    for (const { m, start, end } of doc.matches(regex)) {
      doc.mask(start, end);
      if (!explained(m)) findings.push(unexplained(doc.slice(start, end), 'O texto cita um número que não está no cadastro do imóvel: afirmação inexplicável.'));
    }
  };
  const legal = legalReferenceRegex(options.referenciasLegais || parseTerms(DEFAULT_LEGAL_REFS));
  take(rx('cnpjFormatted'), () => true); // CNPJ no formato oficial (biblioteca única de redaction): identificador, não afirmação
  if (legal) take(legal, () => true);
  take(PHONE, (m) => phoneAllowed(m[0].replace(/\D/g, ''), options.telefonesEmpresa));
  take(DATE_WORDS, (m) => isContentDate(parts, m[1], MONTHS.indexOf(m[2]) + 1, m[3]));
  take(DATE_NUMERIC, (m) => isContentDate(parts, m[1], m[2], m[3]));
  take(WORD_UNITS, () => false);
  take(TOKEN, (m) => YEAR.test(m[0]) || derived.has(m[0]));
  return findings;
}

/** Superlativo verificável ("o maior do bairro", "a única da região"): não há como conferir no cadastro. Adjetivo subjetivo passa. */
function superlativeClaims(doc) {
  return doc.matches(SUPERLATIVE).map(({ start, end }) => {
    doc.mask(start, end);
    return unexplained(doc.slice(start, end), 'O texto faz uma comparação verificável (superlativo) que o cadastro não comprova.');
  });
}

function checkUnknown(doc, facts, options) {
  return [...superlativeClaims(doc), ...numericClaims(doc, options, facts)];
}

module.exports = { checkUnknown };
