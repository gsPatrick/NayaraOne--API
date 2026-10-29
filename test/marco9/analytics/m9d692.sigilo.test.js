'use strict';

// M9-D692 (Caderno §16: "nunca pagamento automático") — varredura estática de src/features/analytics/alerts e dos stores de alerta e prova
// de que a notificação de métrica restrita não traz valor. Não precisa de banco (a parte do aviso usa o formato do texto).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ANALYTICS = path.resolve(__dirname, '../../../src/features/analytics');
const FILES = [
  ...fs.readdirSync(path.join(ANALYTICS, 'alerts')).filter((f) => f.endsWith('.js')).map((f) => path.join(ANALYTICS, 'alerts', f)),
  ...fs.readdirSync(ANALYTICS).filter((f) => /^alert.*\.js$/.test(f)).map((f) => path.join(ANALYTICS, f)),
];
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('m9d692 varredura: nenhum código de alerts chama pagamento, transferência ou aprovação financeira', () => {
  assert.ok(FILES.length >= 15, 'a varredura enxerga o motor, os stores e o novo código');
  const requires = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const calls = /\b(\w*(?:pagar|pagamento|payment|payout|transfer|transferir|approve|aprovar|settle|liquidar|boleto|pix)\w*)\s*\(/gi;
  const offenders = [];
  for (const file of FILES) {
    const src = strip(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(requires)) {
      if (/(^|\/)(finance|billing|payments?|treasury|pagamentos)(\/|$)/.test(m[1])) offenders.push(`${path.basename(file)} importa ${m[1]}`);
      if (/\bfinance\b/.test(m[1])) offenders.push(`${path.basename(file)} importa ${m[1]}`);
    }
    for (const m of src.matchAll(calls)) {
      // a validação que RECUSA ação de pagamento (hasPaymentKey/assertNoPaymentAction/forbidden) é permitida; qualquer outra chamada não
      if (!/^(hasPaymentKey|assertNoPaymentAction|jsonb_has_payment_keys|hasForbiddenKey)$/.test(m[1])) offenders.push(`${path.basename(file)} chama ${m[1]}(`);
    }
    for (const model of ['Payment', 'FinancialEntry', 'LedgerEntry', 'BankTransfer', 'Transfer']) {
      if (new RegExp(`\\b${model}\\.(create|update|bulkCreate|destroy)\\b`).test(src)) offenders.push(`${path.basename(file)} escreve em ${model}`);
    }
    if (/INSERT\s+INTO\s+"?finance"?\./i.test(src) || /UPDATE\s+"?finance"?\./i.test(src)) offenders.push(`${path.basename(file)} escreve em finance.*`);
  }
  assert.deepEqual(offenders, []);
});

test('m9d692 a definição não tem campo de ação financeira e o lint do BI barra serviço de escrita do Financeiro', () => {
  const columns = fs.readFileSync(path.resolve(__dirname, '../../../migrations/20260101009602-create-analytics-alerts-quality-refresh.js'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS \$\{T\('alert_definitions'\)\} \(([\s\S]*?)\n\s{4}\)/.exec(columns)[1];
  assert.doesNotMatch(table.split('CONSTRAINT')[0], /\b(payment|pagamento|pay_|transfer|action)\w*\s+(text|jsonb|boolean|uuid)/i);
  const rule = require('../../../scripts/eslint-rules/analyticsReadOnlyImports');
  assert.ok(rule && rule.create, 'a regra do lint existe (M9-D612)');
  const { ESLint } = require('eslint');
  return new ESLint({ cwd: path.resolve(__dirname, '../../..') }).lintText("require('../../finance/payments.service');", { filePath: path.join(ANALYTICS, 'alerts', 'probe.js') }).then(([res]) => {
    assert.ok(res.messages.some((m) => m.ruleId === 'nayara/analytics-somente-leitura'), 'importar finance de alerts reprova no lint');
  });
});

test('m9d692 o texto do aviso nunca recebe o valor da métrica', () => {
  const { buildNotification } = require('../../../src/features/analytics/alerts/notify.service');
  const note = buildNotification({ alertCode: 'caixa_baixo', severity: 'CRITICAL', metricCode: 'fin.free_cash', instanceId: 'abc', link: '/painel/x', lastValue: '999888.77', value: '999888.77', formattedValue: 'R$ 999.888,77' });
  assert.match(note.title, /caixa_baixo/);
  assert.doesNotMatch(`${note.title} ${note.body}`, /999|888/);
});
