'use strict';

const { RULE } = require('./openapi.constants');
const { resolve } = require('./diff.refs');

/**
 * Compara dois schemas (M9-D840 §3.2). `direction` 'request' ou 'response'. Devolve [{ rule, ruleNumber, where, detail }]. Regras: 2 renomear campo, 3 campo de requisição obrigatório
 * novo, 4 campo de resposta removido/opcional/anulável, 5 tipo ou formato, 6 enum, 7 restrição apertada na requisição.
 */
const change = (rule, ruleNumber, where, detail) => ({ rule, ruleNumber, where, detail });
const sameShape = (a, b) => Boolean(a && b) && a.type === b.type && (a.format || null) === (b.format || null);
const list = (value) => (Array.isArray(value) ? value : []);

function compareEnum(base, cand, where, out) {
  if (!Array.isArray(base.enum) || !Array.isArray(cand.enum)) return;
  for (const value of base.enum) if (!cand.enum.includes(value)) out.push(change(RULE.ENUM_VALUE_REMOVED, 6, where, `valor "${value}" removido`));
  if (base['x-closed'] === true || cand['x-closed'] === true) {
    for (const value of cand.enum) if (!base.enum.includes(value)) out.push(change(RULE.ENUM_VALUE_ADDED_CLOSED, 6, where, `valor "${value}" adicionado em enum fechado (x-closed)`));
  }
}

const TIGHTER = [['maxLength', (b, c) => c < b], ['maxItems', (b, c) => c < b], ['maximum', (b, c) => c < b], ['minLength', (b, c) => c > b], ['minItems', (b, c) => c > b], ['minimum', (b, c) => c > b]];

function compareConstraints(base, cand, where, out) {
  for (const [key, tighter] of TIGHTER) {
    if (typeof cand[key] === 'number' && (typeof base[key] !== 'number' || tighter(base[key], cand[key]))) out.push(change(RULE.CONSTRAINT_TIGHTENED, 7, where, `${key} ${base[key] === undefined ? 'novo' : `${base[key]} -> ${cand[key]}`}`));
  }
  if (typeof cand.pattern === 'string' && cand.pattern !== base.pattern) out.push(change(RULE.CONSTRAINT_TIGHTENED, 7, where, base.pattern === undefined ? 'pattern novo' : 'pattern alterado'));
}

function compareProperties(baseDoc, candDoc, base, cand, ctx, out) {
  const baseProps = base.properties || {};
  const candProps = cand.properties || {};
  const baseRequired = list(base.required);
  const candRequired = list(cand.required);
  const added = Object.keys(candProps).filter((key) => !(key in baseProps));
  for (const key of Object.keys(baseProps)) {
    const where = `${ctx.where}.${key}`;
    if (!(key in candProps)) {
      const old = resolve(baseDoc, baseProps[key]);
      const twin = added.find((name) => sameShape(old, resolve(candDoc, candProps[name])));
      if (twin) out.push(change(RULE.FIELD_RENAMED, 2, where, `campo renomeado para "${twin}"`));
      else if (ctx.direction === 'response') out.push(change(RULE.FIELD_REMOVED, 4, where, 'campo removido da resposta'));
      continue;
    }
    if (ctx.direction === 'response' && baseRequired.includes(key) && !candRequired.includes(key)) out.push(change(RULE.FIELD_NOT_REQUIRED, 4, where, 'campo deixou de ser obrigatório na resposta'));
    if (ctx.direction === 'request' && !baseRequired.includes(key) && candRequired.includes(key)) out.push(change(RULE.REQUEST_REQUIRED_ADDED, 3, where, 'campo da requisição passou a ser obrigatório'));
    compareSchema(baseDoc, candDoc, baseProps[key], candProps[key], { ...ctx, where }, out);
  }
  if (ctx.direction === 'request') {
    for (const key of added) if (candRequired.includes(key)) out.push(change(RULE.REQUEST_REQUIRED_ADDED, 3, `${ctx.where}.${key}`, 'campo obrigatório novo na requisição'));
  }
}

function compareSchema(baseDoc, candDoc, baseNode, candNode, ctx, out = []) {
  const base = resolve(baseDoc, baseNode);
  const cand = resolve(candDoc, candNode);
  if (!base || !cand) return out;
  const key = `${baseNode && baseNode.$ref ? baseNode.$ref : ''}|${ctx.where}`;
  if (ctx.seen.has(key)) return out;
  ctx.seen.add(key);
  if (base.type && cand.type && base.type !== cand.type) out.push(change(RULE.TYPE_CHANGED, 5, ctx.where, `tipo ${base.type} -> ${cand.type}`));
  else if (base.type && (base.format || null) !== (cand.format || null)) out.push(change(RULE.TYPE_CHANGED, 5, ctx.where, `formato ${base.format || 'nenhum'} -> ${cand.format || 'nenhum'}`));
  if (ctx.direction === 'response' && cand.nullable === true && base.nullable !== true) out.push(change(RULE.FIELD_NULLABLE, 4, ctx.where, 'campo da resposta passou a aceitar nulo'));
  compareEnum(base, cand, ctx.where, out);
  if (ctx.direction === 'request') compareConstraints(base, cand, ctx.where, out);
  if (base.type === 'array' || base.items) { if (base.items && cand.items) compareSchema(baseDoc, candDoc, base.items, cand.items, { ...ctx, where: `${ctx.where}[]` }, out); }
  if (base.properties || cand.properties) compareProperties(baseDoc, candDoc, base, cand, ctx, out);
  for (const group of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(base[group]) && Array.isArray(cand[group]) && base[group].length === cand[group].length) {
      base[group].forEach((item, index) => compareSchema(baseDoc, candDoc, item, cand[group][index], { ...ctx, where: `${ctx.where}<${group}${index}>` }, out));
    }
  }
  return out;
}

/** Ponto de entrada: compara dois schemas completos. */
const diffSchemas = (baseDoc, candDoc, baseNode, candNode, direction, where) => compareSchema(baseDoc, candDoc, baseNode, candNode, { direction, where, seen: new Set() }, []);

module.exports = { diffSchemas, change };
