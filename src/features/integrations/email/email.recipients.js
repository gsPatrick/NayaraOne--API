'use strict';

const E = require('./email.errors');

const ADDRESS_RE = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Lista de endereços limpa: texto, sem espaços nas pontas, repetição (sem diferenciar maiúsculas) removida e cada endereço conferido. */
function normalizeList(value) {
  const lista = value === undefined || value === null ? [] : [].concat(value);
  const vistos = new Set();
  const saida = [];
  for (const item of lista) {
    const endereco = String(item === undefined || item === null ? '' : item).trim();
    if (!ADDRESS_RE.test(endereco) || endereco.length > 254) throw E.recipientInvalid(endereco.slice(0, 80));
    if (!vistos.has(endereco.toLowerCase())) { vistos.add(endereco.toLowerCase()); saida.push(endereco); }
  }
  return saida;
}

/**
 * Destinatários da mensagem (para, cópia e cópia oculta): ao menos um destinatário em "para", total até o limite da empresa e um endereço só em um dos campos
 * (quem está em "para" não repete em cópia, e quem está em cópia não repete na oculta).
 */
function normalizeRecipients({ to, cc, bcc }, maxRecipients) {
  const para = normalizeList(to);
  if (para.length === 0) throw E.noRecipient();
  const jaUsados = new Set(para.map((a) => a.toLowerCase()));
  const semRepetir = (lista) => lista.filter((a) => { const k = a.toLowerCase(); if (jaUsados.has(k)) return false; jaUsados.add(k); return true; });
  const copia = semRepetir(normalizeList(cc));
  const oculta = semRepetir(normalizeList(bcc));
  if (para.length + copia.length + oculta.length > maxRecipients) throw E.tooManyRecipients(maxRecipients);
  return { to: para, cc: copia, bcc: oculta };
}

module.exports = { normalizeRecipients, normalizeList };
