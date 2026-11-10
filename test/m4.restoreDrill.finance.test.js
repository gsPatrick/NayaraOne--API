'use strict';

/**
 * Marco 4 — Caderno §21 "Restore/replay financeiro validado" (Guia §1.17, pedido M4-25 "Restore e
 * replay financeiro sem duplicidade"). Executa o drill real (scripts/restoreDrill/financeFullDrill.js)
 * como processo filho: dois clusters PostgreSQL descartáveis (portas 5523/5524), fixtures pelos
 * serviços reais, pg_dump -Fc, restore em cluster NOVO, comparação origem × destino com hash,
 * invariantes, RLS, replays e adulteração. Lê o relatório JSON gravado e confere cada prova.
 * Só se pula quando os binários do PostgreSQL não existem na máquina.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PG_BIN } = require('../scripts/lib/disposableCluster');

const API_ROOT = path.join(__dirname, '..');
const hasPg = Boolean(PG_BIN) && fs.existsSync(path.join(PG_BIN, 'initdb')) && fs.existsSync(path.join(PG_BIN, 'pg_dump'));

test('M4-§21.14 restore/replay financeiro: dump/restore em cluster novo preserva dados, hashes e invariantes, e o replay não duplica', { timeout: 20 * 60 * 1000 }, (t) => {
  if (!hasPg) {
    t.skip('binários do PostgreSQL (initdb/pg_dump) não encontrados — defina DRILL_PG_BIN para rodar o drill');
    return;
  }
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-restore-drill-report-'));
  try {
    const run = spawnSync('node', ['scripts/restoreDrill/financeFullDrill.js', '--port', '5523', '--report-dir', reportDir], {
      cwd: API_ROOT, env: { ...process.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, `drill terminou com exit ${run.status}:\n${output.split('\n').filter((l) => l.includes('❌')).join('\n') || output.slice(-3000)}`);
    const file = fs.readdirSync(reportDir).find((f) => /^drill-finance-restore-.*\.json$/.test(f));
    assert.ok(file, 'o drill gravou o relatório JSON');
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, file), 'utf8'));

    assert.equal(report.exitCode, 0);
    assert.ok(report.checagens.total > 0, 'há checagens');
    assert.equal(report.checagens.aprovadas, report.checagens.total, 'todas as checagens aprovadas');
    assert.ok(report.objetos.length >= 20, `objetos comparados: ${report.objetos.length}`);
    for (const o of report.objetos) {
      assert.equal(o.hashEqual, true, `hash origem = destino em ${o.objectName}`);
      assert.equal(o.hashSource, o.hashTarget, o.objectName);
      assert.equal(o.failures, 0, o.objectName);
    }
    for (const name of ['finance.financial_entries', 'finance.ledger', 'finance.payment_intents', 'finance.reconciliations', 'finance.owner_repasses',
      'finance.commissions', 'finance.commission_installments', 'finance.intercompany_transfers', 'finance.period_closures', 'finance.anomaly_cases']) {
      const o = report.objetos.find((x) => x.objectName === name);
      assert.ok(o && o.records > 0 && o.comparedWithValue > 0, `${name} comparado com registros`);
    }

    // Recebível de R$ 0,30: 0,10 + 0,20 baixados, saldo 0,20 → 0,00 e, no destino, 0,30 − Σ = 0,00.
    const r030 = report.fixtures.tenantA.receivable030;
    assert.equal(r030.amount, '0.30');
    assert.deepEqual(r030.steps.map((s) => [s.amount, s.remainingAmount, s.parentStatus]), [['0.10', '0.20', 'PARTIALLY_SETTLED'], ['0.20', '0.00', 'SETTLED']]);
    const saldo = report.verificacao.find((c) => c.objectName === 'recebível R$ 0,30' && c.label.startsWith('saldo = 0,30'));
    assert.ok(saldo && saldo.ok && saldo.label.endsWith('= 0.00'), 'saldo restaurado = 0,00');
    const appendOnly = report.verificacao.filter((c) => c.objectName === 'ledger append-only (destino)');
    assert.ok(appendOnly.length >= 4 && appendOnly.every((c) => c.ok), 'ledger append-only no destino');
    assert.ok(report.verificacao.filter((c) => c.objectName === 'RLS (destino)').every((c) => c.ok), 'RLS no destino');

    // Replays sem duplicidade e adulteração detectada.
    const byName = (prefix) => report.replays.find((r) => r.replay.startsWith(prefix));
    const cb = byName('callback bancário');
    assert.equal(cb.lancamentosAntes, cb.lancamentosDepois);
    const ext = byName('reimportação');
    assert.equal(ext.importadas, 0);
    assert.equal(ext.antes, ext.depois);
    const idem = byName('lançamento com idempotencyKey');
    assert.equal(idem.servico, 'FINANCE_DUPLICATE_PAYMENT');
    assert.equal(idem.banco, '23505');
    assert.equal(idem.antes, idem.depois);
    const sp = byName('mesma baixa parcial');
    assert.equal(sp.filhasAntes, 2);
    assert.equal(sp.filhasDepois, 2);
    const cm = byName('mesma comissão');
    assert.equal(cm.antes, cm.depois);
    const tamper = byName('adulteração');
    assert.equal(tamper.detectada, true);
    assert.notEqual(tamper.hashAntes, tamper.hashDepois);
    assert.ok(report.replayEAdulteracao.every((c) => c.ok), 'todas as checagens de replay/adulteração');
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
});
