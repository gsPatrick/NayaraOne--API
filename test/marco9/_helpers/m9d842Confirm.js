'use strict';

// Apoio do contract test (M9-D842 + M9-D852, não é teste): exemplos com `confirm` pedem a simulação de impacto à API real e levam o `confirmation` no corpo, como a
// tela (ConfirmAction) faz. `confirm: { impact: "GET /caminho/{id}/impact" }` (ou "POST /caminho/impact", que reusa o corpo do exemplo); `mfa: true` do exemplo
// também habilita o MFA do ator no banco descartável (nunca por endpoint).
const { resolve } = require('../../../src/features/core-governance/api-governance/contract/examples.template');
const { grantRecentMfa } = require('./m9d852Confirm');
const { DEFAULT_JUSTIFICATION } = require('./m9d852Confirm');

async function addConfirmation(example, vars, { baseUrl, tokens, tenants }) {
  if (!example.confirm) return;
  const tenant = example.as === 'gestorB' ? tenants.B : tenants.A;
  if (example.mfa) await grantRecentMfa(tenant);
  const [method, template] = example.confirm.impact.split(' ');
  const resolved = resolve({ params: example.params || {}, body: example.body }, vars);
  const path = template.replace(/\{(\w+)\}/g, (_m, name) => resolved.params[name]);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[example.as]}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(resolved.body || {}) : undefined,
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`a simulação de impacto ${example.confirm.impact} devolveu ${res.status}: ${JSON.stringify(body)}`);
  const d = body.data;
  example.body = { ...(example.body || {}), confirmation: { understood: true, impactToken: d.impactToken, ...(d.level >= 3 ? { typedCode: d.record.code, justification: DEFAULT_JUSTIFICATION } : {}) } };
}

module.exports = { addConfirmation };
