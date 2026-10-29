'use strict';

const { resolve, pick } = require('./examples.template');
const { listOperations, fillPath } = require('./operations');
const { checkResponse } = require('./response.check');
const { exampleInvalid, statusNotDocumented } = require('./contract.errors');
const { documentedResponse } = require('./operations');

/** Lê a resposta como a suíte precisa: cabeçalhos em minúsculas, JSON quando o tipo é JSON, tamanho do corpo. */
async function readResponse(res) {
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  const headers = {};
  res.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  let json;
  if (/json/i.test(contentType)) { try { json = JSON.parse(buffer.toString('utf8')); } catch (_e) { json = undefined; } }
  return { status: res.status, headers, contentType, json, text: /json|text/i.test(contentType) ? buffer.toString('utf8') : (buffer.length ? '<binário>' : ''), bytes: buffer.length };
}

function buildRequest(example, resolved, tokens, baseUrl, pathTemplate) {
  const url = new URL(`${baseUrl}${fillPath(pathTemplate, resolved.params)}`);
  for (const [name, value] of Object.entries(resolved.query || {})) url.searchParams.set(name, String(value));
  const headers = { ...(resolved.headers || {}) };
  const token = tokens[example.as];
  if (example.as !== 'anon' && !token) throw new Error(`sem token para o ator "${example.as}"`);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (resolved.body !== undefined) headers['Content-Type'] = 'application/json';
  return { url: url.toString(), init: { method: example.op.split(' ')[0], headers, body: resolved.body === undefined ? undefined : JSON.stringify(resolved.body) } };
}

/**
 * Executa UM exemplo contra a API de verdade e devolve { example, ok, status, findings, captured }. `ctx` = { baseUrl, doc, codes, tokens, vars, hooks, fetchImpl }. `vars` é a memória
 * compartilhada entre exemplos (o que um exemplo captura, o seguinte usa). `hooks.before(example, vars)` prepara o ambiente ANTES de resolver o exemplo (dados de partida do exemplo e MFA recente quando ele pede `mfa`) e pode acrescentar variáveis.
 */
async function runExample(example, ctx) {
  const operation = listOperations(ctx.doc).find((item) => item.key === example.op);
  if (!operation) return { example, ok: false, status: null, findings: [exampleInvalid(`a operação ${example.op} não existe no contrato`, { op: example.op })] };
  const started = Date.now();
  let resolved;
  let actual;
  try {
    if (ctx.hooks && ctx.hooks.before) await ctx.hooks.before(example, ctx.vars);
    resolved = resolve({ params: example.params || {}, query: example.query || {}, headers: example.headers || {}, body: example.body }, ctx.vars);
    const request = buildRequest(example, resolved, ctx.tokens, ctx.baseUrl, operation.path);
    actual = await readResponse(await (ctx.fetchImpl || fetch)(request.url, request.init));
  } catch (err) {
    return { example, ok: false, status: null, findings: [exampleInvalid(`${err.message}`, { op: example.op, name: example.name })], ms: Date.now() - started };
  }
  const findings = checkResponse({ method: operation.method, path: operation.path, operation: operation.operation, components: ctx.doc.components, codes: ctx.codes, actual });
  if (actual.status !== example.expect && !findings.some((item) => item.code === statusNotDocumented(actual.status, operation.path).code)) {
    findings.push(exampleInvalid(`o exemplo "${example.name}" de ${example.op} esperava ${example.expect} e a API devolveu ${actual.status}`, { op: example.op, expected: example.expect, actual: actual.status, error: actual.json && actual.json.error ? actual.json.error.code : undefined }));
  }
  const captured = {};
  if (!findings.length) for (const [name, dotted] of Object.entries(example.capture || {})) captured[name] = pick({ body: actual.json, headers: actual.headers }, dotted);
  Object.assign(ctx.vars, captured);
  return { example, ok: findings.length === 0, status: actual.status, documented: Boolean(documentedResponse(operation.operation, actual.status)), findings, captured, ms: Date.now() - started };
}

module.exports = { runExample, readResponse, buildRequest };
