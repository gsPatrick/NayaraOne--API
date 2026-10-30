'use strict';

/**
 * Mapping por portal (M9-D232 3.2): tabela de campos do read model público -> campos do portal, com os enums de tipo de imóvel e de finalidade do portal.
 * `mapping = { version, capabilities, fields: [{ from, to, required?, capability? }], enums: { <campo>: { <valor nosso>: <valor do portal> } } }`.
 *  - capacidade ausente NÃO falha: o campo é omitido e entra em `fieldsDropped`;
 *  - atributo obrigatório ausente (ou valor sem correspondência no enum do portal) entra em `missing` (o anúncio vira REJECTED internamente, sem chamar o portal).
 * Função pura sobre o pedido já minimizado (M9-D219): nada de leitura de tabela de imóveis.
 */
const vazio = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function applyMapping(mapping, request) {
  const origem = request && typeof request === 'object' ? request : {};
  const payload = {};
  const fieldsDropped = [];
  const missing = [];
  for (const f of mapping.fields) {
    const valor = origem[f.from];
    if (vazio(valor)) {
      if (f.required) missing.push(f.from);
      continue;
    }
    if (f.capability && !mapping.capabilities.includes(f.capability)) {
      fieldsDropped.push(f.from);
      continue;
    }
    const tabela = mapping.enums && mapping.enums[f.from];
    if (tabela) {
      if (!Object.prototype.hasOwnProperty.call(tabela, valor)) { missing.push(f.from); continue; }
      payload[f.to] = tabela[valor];
    } else {
      payload[f.to] = valor;
    }
  }
  return { payload, fieldsDropped, missing };
}

module.exports = { applyMapping };
