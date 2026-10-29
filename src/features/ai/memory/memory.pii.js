'use strict';

const { redactForAi } = require('../../../shared/redaction');
const { requiredFields } = require('./memory.schema');

/**
 * Dado pessoal na memória (M9-D009, regra 3): CPF, CNPJ, telefone, e-mail, endereço e dado bancário só ficam quando a finalidade está
 * preenchida e o tipo permite (`ia.memoria.tipos_com_dado_pessoal`). Senão o campo sai da gravação (campo obrigatório fica com o
 * texto redigido `[REDIGIDO:tipo]`). Segredo (token, senha) nunca fica. A detecção é a da biblioteca única de redaction (perfil ai).
 */
const SEGREDOS = new Set(['token', 'senha', 'segredo', 'restrito']);

/** Redige uma folha de texto e diz que tipos achou. */
function scanText(texto) {
  const tipos = new Set();
  const redigido = redactForAi(texto, { placeholderFor: (tipo) => { tipos.add(tipo); return `[REDIGIDO:${tipo}]`; } });
  return { redigido, tipos };
}

function cleanLeaf(v, keep, found) {
  if (typeof v !== 'string') return { value: v, removed: false };
  const { redigido, tipos } = scanText(v);
  if (!tipos.size) return { value: v, removed: false };
  tipos.forEach((t) => found.add(t));
  const temSegredo = [...tipos].some((t) => SEGREDOS.has(t));
  if (keep && !temSegredo) return { value: v, removed: false };
  return { value: redigido, removed: true };
}

/**
 * Devolve { value, removed, found }: `removed` lista os campos (e itens de lista) que perderam o dado; `found` os tipos achados.
 * `permit` = finalidade preenchida E tipo permitido.
 */
function applyPiiPolicy(type, value, { permit }) {
  const obrigatorios = requiredFields(type);
  const found = new Set();
  const removed = [];
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      const itens = v.map((item) => cleanLeaf(item, permit, found));
      if (itens.some((i) => i.removed)) removed.push(name);
      out[name] = itens.map((i) => i.value);
      continue;
    }
    const r = cleanLeaf(v, permit, found);
    if (!r.removed) { out[name] = v; continue; }
    removed.push(name);
    if (obrigatorios.has(name)) out[name] = r.value;
  }
  return { value: out, removed, found: [...found] };
}

module.exports = { applyPiiPolicy, scanText };
