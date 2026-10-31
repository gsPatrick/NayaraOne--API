'use strict';

const { rx, cpfValid, cnpjValid, containsCardNumber, maskCpf, maskCnpj } = require('../../../../shared/redaction');
const { PAN_BODY } = require('./inbound.constants');

/** O texto tem número de cartão completo? A decisão mora na biblioteca de redaction. */
const hasPan = containsCardNumber;

/**
 * analyzePii(texto) — detecta CPF, CNPJ, cartão e conta/agência (M9-D235 3.1 item 3), SÓ com a biblioteca de redaction. Devolve { text, types, pan }:
 * com cartão completo (PAN válido) o texto inteiro é redigido; sem ele, cada ocorrência é mascarada (`***.456.789-**`).
 */
function analyzePii(texto) {
  const original = String(texto === undefined || texto === null ? '' : texto);
  if (hasPan(original)) return { text: PAN_BODY, types: ['CARD'], pan: true };
  const types = new Set();
  const marca = (tipo, valida, mascara) => (m) => { if (valida && !valida(m)) return m; types.add(tipo); return mascara(m); };
  let out = original;
  out = out.replace(rx('cnpjFormatted'), marca('CNPJ', null, maskCnpj));
  out = out.replace(rx('cnpjBare'), marca('CNPJ', cnpjValid, maskCnpj));
  out = out.replace(rx('cpfFormatted'), marca('CPF', null, maskCpf));
  out = out.replace(rx('cpfBare'), marca('CPF', cpfValid, maskCpf));
  for (const nome of ['agencyLabeled', 'accountLabeled']) {
    out = out.replace(rx(nome, 'gi'), (_m, rotulo) => { types.add('ACCOUNT'); return `${rotulo}***`; });
  }
  return { text: out, types: [...types], pan: false };
}

module.exports = { analyzePii, hasPan };
