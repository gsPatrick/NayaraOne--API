'use strict';

// M9-D673 (reabertura F08, 01/11/2026) — os painéis de Marketing e Atendimento (e todos os de BI) tratam o 403 pelo estado comum de falta de permissão, sem alerta próprio,
// e a dica do cartão traz o rótulo em português com o código só na dica. Leitura do código do Front.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONT = path.resolve(__dirname, '../../../../NayaraOne--FRONT');
const read = (rel) => fs.readFileSync(path.join(FRONT, rel), 'utf8');
const pages = fs.readdirSync(path.join(FRONT, 'app/painel/analytics'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('m9d673 todo painel de BI abre pelo componente comum, que usa o estado único de falta de permissão', () => {
  assert.ok(pages.includes('marketing') && pages.includes('atendimento'));
  for (const name of pages.filter((n) => n !== 'saude')) {
    const page = read(`app/painel/analytics/${name}/page.js`);
    assert.match(page, /BiDashboard|CommandCenter/, `${name}: sem tratamento de 403 próprio, usa o componente comum`);
    assert.ok(!/Alert/.test(page) && !/403/.test(page), `${name}: a página não trata o 403 por conta própria`);
  }
  const dash = read('components/organisms/BiDashboard/BiDashboard.js');
  assert.match(dash, /AsyncState/);
  assert.match(dash, /classifyFailure/);
  assert.ok(!/<Alert tone="danger">\{error\}/.test(dash), 'sem alerta de erro próprio no painel');
});

test('m9d673 dica do cartão: rótulo em português primeiro, código só dentro da dica', () => {
  const card = read('components/molecules/analytics/BiMetricCard/BiMetricCard.js');
  assert.match(card, /title=\{metricTooltip\(/);
  const text = read('lib/analytics/panelText.js');
  assert.match(text, /\(\$\{code\}\)/, 'o código entra entre parênteses na dica');
  assert.ok(!/<h3[^>]*>\{[^}]*metricCode\s*\}<\/h3>/.test(card), 'o título do cartão não é o código');
});
