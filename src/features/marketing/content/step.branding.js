'use strict';

const repo = require('./pipeline.repository');
const { sha256, canonicalJson } = require('./sourceStamp');
const { variableMissing, contentInvalid } = require('./pipeline.errors');
const { DEFINITIONS } = require('./types/definitions');

const ALIASES = Object.freeze({ preco: ['precoVenda', 'precoLocacao'] });
const NBSP = new RegExp(String.fromCharCode(92) + 'u00a0|' + String.fromCharCode(92) + 'u202f', 'g');
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value)).replace(NBSP, ' ');

function rawValue(name, { variables, facts, body, item }) {
  if (variables && variables[name] !== undefined && variables[name] !== null) return variables[name];
  if (name === 'texto') return body.texto;
  if (name === 'titulo') return item.title;
  if (facts[name] !== undefined && facts[name] !== null) return facts[name];
  for (const alias of ALIASES[name] || []) if (facts[alias] !== undefined && facts[alias] !== null) return facts[alias];
  return undefined;
}

function formatValue(value, type) {
  return type === 'money' ? money(value) : String(value);
}

/** Preenche {{variáveis}} do template com os valores informados, o texto, o título e os fatos; falta valor: 422 com a lista. */
function renderTemplate(template, ctx) {
  const types = new Map((template.variables_json || []).map((v) => [v.name, v.type]));
  const missing = [];
  const rendered = String(template.body).replace(/\{\{([^{}]*)\}\}/g, (_all, inner) => {
    const name = inner.trim();
    const value = rawValue(name, ctx);
    if (value === undefined) { missing.push(name); return ''; }
    return formatValue(value, types.get(name));
  });
  if (missing.length > 0) throw variableMissing([...new Set(missing)]);
  return rendered;
}

/** Resolve o template: o pedido (PUBLISHED mais recente do código ou id), o que a versão já usa ou o padrão do tipo. Nenhum: sem marca. */
async function resolveTemplate(version, input, transaction, item) {
  if (input.templateId || input.templateCode) {
    const template = await repo.findPublishedTemplate({ templateId: input.templateId, code: input.templateCode }, transaction);
    if (!template) throw contentInvalid('Template não encontrado ou não publicado.', { templateId: input.templateId, templateCode: input.templateCode });
    return template;
  }
  if (version.template_id) return repo.findPublishedTemplate({ templateId: version.template_id, anyStatus: true }, transaction);
  const definition = item && DEFINITIONS[item.type];
  // M9-D409: sem pedido nem template anterior, vale o template padrão do tipo SE ele estiver publicado (senão, sem molde).
  return definition ? repo.findPublishedTemplate({ code: definition.defaultTemplateCode }, transaction) : null;
}

/**
 * M9-D406 função 5 — applyTemplate(contentVersion, template): aplica o template (variáveis e tokens da marca) e calcula o novo
 * content_hash. O corpo de uma versão é imutável, então o resultado é a PRÓXIMA versão (com o rascunho e os checks anteriores).
 * Sem template, o passo conclui sem criar versão (o conteúdo segue sem molde).
 */
async function brandingStep({ item, version, tenant, actor, transaction }, input) {
  const template = await resolveTemplate(version, input || {}, transaction, item);
  if (!template) return { ok: true, detalhes: { semTemplate: true } };
  const body = version.body_json;
  const facts = version.facts_snapshot_json || {};
  const renderizado = renderTemplate(template, { variables: input && input.variables, facts, body, item });
  const nextBody = { ...body, renderizado, marca: template.brand_tokens_json || {}, templateCode: template.code };
  const contentHash = sha256(canonicalJson({ body: nextBody, facts, template: [template.id, template.version_no, template.content_hash] }));
  const created = await repo.insertNextVersion(tenant, actor, version, {
    body: nextBody, templateId: template.id, templateVersionNo: template.version_no, contentHash,
  }, transaction);
  return { ok: true, detalhes: { templateId: template.id, templateVersionNo: template.version_no, contentHash }, newVersion: created };
}

module.exports = { brandingStep, renderTemplate };
