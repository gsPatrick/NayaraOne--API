#!/usr/bin/env node
'use strict';

/**
 * securityScan.js — Caderno Técnico, página 165, item 13 ("segurança/antifraude do módulo de
 * Obras"): a auditora externa pediu evidência de "security scan" para o Marco 6. Este script
 * roda `npm audit --json` CONTRA AS DEPENDÊNCIAS DE PRODUÇÃO (--omit=dev — devDependencies
 * como eslint/nodemon não vão pra produção, então uma vulnerabilidade só nelas não deve
 * bloquear o build) via `child_process.execFile` (nunca `exec` com string interpolada — ver
 * a regra de SAST abaixo que o próprio scanner respeita), parseia o resultado real e falha
 * (`process.exitCode = 1`) se existir QUALQUER vulnerabilidade de severidade `high` ou
 * `critical` — moderate/low viram apenas um warning no log, não bloqueiam o CI.
 *
 * Uso: `node scripts/securityScan.js` (chamado como step do CI em
 * .github/workflows/test.yml). Saída: resumo por severidade + lista de pacotes afetados.
 *
 * RESULTADO REAL rodado em 08/10/2026 (documentado também em scripts/README-security.md):
 *   moderate: 3, high: 1, critical: 1 (total 5 advisories agrupados em 5 pacotes:
 *   brace-expansion [high], moment [moderate], proxy-addr [critical], sequelize [moderate],
 *   uuid [moderate]). brace-expansion/moment/proxy-addr têm fix não-major disponível
 *   (`npm audit fix`); sequelize/uuid só têm fix via downgrade major de sequelize (3.30.0),
 *   fora do escopo deste scanner — tratado como item de hardening futuro, documentado no
 *   README, não escondido.
 */

const { execFile } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function runNpmAudit() {
  return new Promise((resolve) => {
    // --omit=dev: escopo é "dependências de produção" (TAREFA 1.1) — devDependencies (eslint,
    // nodemon, node --test helpers) não embarcam no runtime, então vulnerabilidade só nelas
    // não deve bloquear o build de produção.
    // npm audit sai com exit code 1 quando ENCONTRA vulnerabilidade — isso não é uma falha de
    // execução do comando, por isso não rejeitamos a Promise no `error`, só nos importa o
    // stdout (JSON) parseado abaixo.
    execFile(
      'npm',
      ['audit', '--omit=dev', '--json'],
      { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      }
    );
  });
}

async function main() {
  const { stdout, stderr } = await runNpmAudit();

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (parseErr) {
    console.error('securityScan: não foi possível parsear a saída de "npm audit --json".');
    console.error('stdout bruto:', stdout);
    console.error('stderr:', stderr);
    process.exitCode = 1;
    return;
  }

  const counts = (report.metadata && report.metadata.vulnerabilities) || {};
  const vulnerabilities = report.vulnerabilities || {};

  console.log('=== securityScan — npm audit (dependências de produção) ===');
  console.log(
    `info=${counts.info || 0} low=${counts.low || 0} moderate=${counts.moderate || 0} high=${counts.high || 0} critical=${counts.critical || 0} total=${counts.total || 0}`
  );

  const blockingPackages = Object.entries(vulnerabilities).filter(([, v]) => BLOCKING_SEVERITIES.has(v.severity));
  const nonBlockingPackages = Object.entries(vulnerabilities).filter(([, v]) => !BLOCKING_SEVERITIES.has(v.severity));

  if (nonBlockingPackages.length > 0) {
    console.log('\n--- moderate/low (warning, não bloqueia o build) ---');
    for (const [name, v] of nonBlockingPackages) {
      const fix = v.fixAvailable ? (v.fixAvailable === true ? 'fix disponível (npm audit fix)' : `fix via ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}`) : 'sem fix disponível';
      console.log(`  - ${name} (${v.severity}) — ${fix}`);
    }
  }

  if (blockingPackages.length > 0) {
    console.log('\n--- HIGH/CRITICAL (bloqueia o build) ---');
    for (const [name, v] of blockingPackages) {
      const fix = v.fixAvailable ? (v.fixAvailable === true ? 'fix disponível (npm audit fix)' : `fix via ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}`) : 'SEM fix disponível';
      console.log(`  - ${name} (${v.severity}) — ${fix}`);
    }
    console.error(
      `\nsecurityScan: ${blockingPackages.length} pacote(s) com vulnerabilidade HIGH/CRITICAL. Rode "npm audit fix" (ou avalie o upgrade major indicado) antes de prosseguir.`
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nsecurityScan: nenhuma vulnerabilidade HIGH/CRITICAL em dependências de produção.');
}

main().catch((err) => {
  console.error('securityScan: erro inesperado ao rodar o scan.', err);
  process.exitCode = 1;
});
