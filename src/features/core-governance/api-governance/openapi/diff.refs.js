'use strict';

/** Resolve `$ref` internos (#/components/...) com guarda de ciclo. Referência quebrada devolve null (o contrato é inválido para comparação). */
function resolve(doc, node, seen = new Set()) {
  let current = node;
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref) || !current.$ref.startsWith('#/')) return null;
    seen.add(current.$ref);
    current = current.$ref.slice(2).split('/').reduce((acc, key) => (acc ? acc[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
  }
  return current === undefined ? null : current;
}

/** Schema JSON de uma resposta ou corpo (application/json), resolvido; null se não houver. */
function jsonSchemaOf(doc, content) {
  const body = resolve(doc, content);
  const media = body && body.content && (body.content['application/json'] || Object.values(body.content)[0]);
  return media && media.schema ? media.schema : null;
}

module.exports = { resolve, jsonSchemaOf };
