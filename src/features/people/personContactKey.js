'use strict';

/**
 * Chave de comparação de contato da deduplicação (M3-03 / CAD-04, DI-M3PE-3). Livro §4: "Match médio: telefone/e-mail iguais." Igual quer
 * dizer o mesmo endereço, não o mesmo texto digitado:
 * - e-mail: sem espaços e em minúsculas;
 * - telefone e WhatsApp: só os dígitos, com o DDI. Número que não começa com "+" e tem até 11 dígitos (DDD + número) recebe o DDI padrão
 *   da empresa (parâmetro `people.deduplicacao.ddi_padrao`). Telefone e WhatsApp com o mesmo número são o mesmo contato.
 * O valor guardado em person_contacts não muda: a chave é calculada na comparação, dos dois lados, inclusive para os cadastros antigos.
 */
const PHONE_TYPES = Object.freeze(['PHONE', 'WHATSAPP']);
const NATIONAL_MAX_DIGITS = 11;

const kindOf = (contactType) => (String(contactType || '').toUpperCase() === 'EMAIL' ? 'EMAIL' : PHONE_TYPES.includes(String(contactType || '').toUpperCase()) ? 'PHONE' : null);

/** Chave do contato, ou null quando não há o que comparar (tipo desconhecido, vazio, telefone com menos de 8 dígitos ou e-mail sem @). */
function contactKey(contactType, value, ddi) {
  const kind = kindOf(contactType);
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!kind || !text) return null;
  if (kind === 'EMAIL') {
    const email = text.replace(/\s+/g, '').toLowerCase();
    return email.includes('@') ? { kind, key: email } : null;
  }
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const withDdi = text.startsWith('+') || digits.length > NATIONAL_MAX_DIGITS ? digits : `${String(ddi || '')}${digits}`;
  return { kind, key: withDdi };
}

/** Chaves distintas dos contatos do rascunho (qualquer contato, não só o principal). */
function draftContactKeys(contacts, ddi) {
  const seen = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    if (!contact) continue;
    const k = contactKey(contact.contactType || contact.channel || contact.type, contact.valueNormalized || contact.value, ddi);
    if (k) seen.set(`${k.kind}|${k.key}`, k);
  }
  return [...seen.values()];
}

/**
 * Expressão SQL da mesma chave sobre uma linha de people.person_contacts (`alias`), com o DDI no parâmetro nomeado `:ddi`. Tem de dar o
 * mesmo resultado de contactKey (o teste people.deduplicacao.contato confere os dois lados).
 */
function contactKeySql(alias = 'c') {
  const v = `${alias}.value_normalized`;
  const digits = `regexp_replace(${v}, '[^0-9]', '', 'g')`;
  return `(CASE WHEN upper(${alias}.contact_type) = 'EMAIL' THEN lower(regexp_replace(${v}, '\\s', '', 'g'))
    WHEN btrim(${v}) LIKE '+%' OR length(${digits}) > ${NATIONAL_MAX_DIGITS} THEN ${digits}
    ELSE CAST(:ddi AS text) || ${digits} END)`;
}

const kindSql = (alias = 'c') => `(CASE WHEN upper(${alias}.contact_type) = 'EMAIL' THEN 'EMAIL' ELSE 'PHONE' END)`;

module.exports = { PHONE_TYPES, contactKey, draftContactKeys, contactKeySql, kindSql, kindOf };
