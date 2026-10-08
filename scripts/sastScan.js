#!/usr/bin/env node
'use strict';

/**
 * sastScan.js — Caderno Técnico, página 165, item 13: além do "security scan" de dependências
 * (scripts/securityScan.js), a auditora pediu evidência de SAST. Este é um SAST simples e real
 * (regex sobre o código-fonte, sem AST — mesma filosofia de scripts/scanConstructionHardcode.js
 * já usado no CI deste repositório), varrendo `src/` atrás de 4 padrões perigosos conhecidos:
 *
 *   1. `eval(` — execução de código arbitrário.
 *   2. `child_process.exec(`/`require('child_process').exec(` com argumento que parece
 *      concatenação/interpolação de variável (não `execFile`, que recebe args como array e não
 *      sofre shell injection da mesma forma).
 *   3. Senha hardcoded: `password` seguido de `=`/`:` e uma string literal de 3+ caracteres —
 *      ignorando arquivos `.env.example` e arquivos de teste (`test/`, `*.test.js`), onde um
 *      valor fixo de senha de teste é esperado e documentado.
 *   4. SQL Injection por concatenação direta de input de requisição: `SELECT`/`INSERT`/
 *      `UPDATE`/`DELETE` seguido de `+` e `req.` na mesma linha — indica string SQL montada por
 *      concatenação de `req.body`/`req.query`/`req.params` em vez de bind parameter
 *      (`:replacement`/`?`), que é o padrão usado em todo o resto do repositório (ver qualquer
 *      `sequelize.query` com `replacements:`).
 *
 * Não é um scanner perfeito (regex, não AST) — propositalmente conservador, mesmo espírito do
 * scanner de hard-code já existente: falso positivo legítimo deve ser corrigido no código-fonte
 * (não existe `scanner:allow` aqui porque nenhum dos 4 padrões tem uso legítimo em código de
 * aplicação de produção).
 *
 * Uso: `node scripts/sastScan.js` — sai com código 1 e imprime as ocorrências se encontrar
 * alguma, código 0 ("0 ocorrências") se limpo.
 */

const fs = require('fs');
const path = require('path');

const TARGET_DIR = path.join(__dirname, '..', 'src');

const RULES = [
  {
    id: 'EVAL',
    description: 'eval(...) — execução de código arbitrário',
    pattern: /\beval\s*\(/,
  },
  {
    id: 'EXEC_SHELL_INTERPOLATION',
    description: 'child_process.exec(...) com string interpolada/concatenada (não execFile)',
    pattern: /\bexec\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+)/,
  },
  {
    id: 'HARDCODED_PASSWORD',
    description: 'possível senha hardcoded (password = "...")',
    pattern: /password\s*[:=]\s*['"][^'"]{3,}['"]/i,
  },
  {
    id: 'SQL_CONCAT_INJECTION',
    description: 'SQL montado por concatenação direta de req.* (SQL injection)',
    pattern: /(SELECT|INSERT|UPDATE|DELETE)[^;]*\+[^;]*req\./i,
  },
];

function isExcluded(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('.env.example')) return true;
  if (/\/test\//.test(normalized) || normalized.endsWith('.test.js')) return true;
  return false;
}

function scanFile(filePath) {
  if (isExcluded(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const findings = [];

  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ ruleId: rule.id, description: rule.description, line: idx + 1, content: line.trim() });
      }
    }
  });

  return findings;
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  const files = walk(TARGET_DIR);
  let totalFindings = 0;

  console.log(`=== sastScan — varredura de padrões perigosos em ${path.relative(path.join(__dirname, '..'), TARGET_DIR)}/ ===`);
  console.log(`Arquivos varridos: ${files.length}`);

  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length > 0) {
      totalFindings += findings.length;
      const relative = path.relative(path.join(__dirname, '..'), file);
      console.log(`\n${relative}:`);
      for (const f of findings) {
        console.log(`  linha ${f.line} [${f.ruleId}] ${f.description}`);
        console.log(`    ${f.content}`);
      }
    }
  }

  if (totalFindings === 0) {
    console.log('\nsastScan: 0 ocorrências.');
    process.exitCode = 0;
  } else {
    console.error(`\nsastScan: ${totalFindings} ocorrência(s) encontrada(s) — revise antes de prosseguir.`);
    process.exitCode = 1;
  }
}

main();
