#!/usr/bin/env node
'use strict';

/**
 * scanConstructionHardcode.js — M6-96 ("Scanner de hard-code no CI").
 *
 * Seção 23 do Anexo I ("Scanner de hard-code") pede um step de CI que vigie contra margem
 * mínima, comissão e outros percentuais/valores monetários fixados diretamente em código —
 * em vez de virem do Motor de Regras (`rule_version_id`). Este script varre
 * `src/features/construction/` (código de produção, não migrations/testes/config) atrás de
 * dois padrões suspeitos:
 *
 *   1. Frações decimais tipo `0.4` / `0.15` fora de comentário — candidato a percentual/taxa
 *      fixado no código (margem, comissão, desconto).
 *   2. Números inteiros "redondos" de 4+ dígitos (ex.: `1500`, `2500`) fora de comentário —
 *      candidato a valor monetário fixado no código.
 *
 * Não é um scanner perfeito (não tem AST, é baseado em regex sobre o código já sem
 * comentários) — propositalmente conservador: qualquer linha legítima que precise de um
 * literal numérico desse formato (ex.: uma constante de configuração) deve declarar o valor
 * em um arquivo de config/env, OU, se for genuinamente parte do código (não regra de
 * negócio), marcar a linha com o comentário `scanner:allow` explicando o motivo — a mesma
 * revisão humana que qualquer allowlist de scanner de segurança exige.
 *
 * Uso: `node scripts/scanConstructionHardcode.js` — sai com código 1 e imprime as ocorrências
 * se encontrar alguma, código 0 se limpo. Chamado como step do workflow de CI
 * (.github/workflows/test.yml).
 */

const fs = require('fs');
const path = require('path');

const TARGET_DIR = path.join(__dirname, '..', 'src', 'features', 'construction');
const ALLOW_MARKER = 'scanner:allow';

// Frações decimais fora de intervalo "estrutural" comum (0, 1) — candidatas a percentual
// hard-coded. Ex.: 0.4, 0.15, 0.075.
const DECIMAL_RATE_PATTERN = /(?<![\w.])0\.\d+(?!\d)/g;

// Inteiros de 4+ dígitos "redondos" (terminam em 00) — candidatos a valor monetário
// hard-coded (ex.: 1500, 2500, 10000). Números como 2026 (ano) ou 1000000000000 (uuid/hash)
// não batem porque exigimos terminar em "00".
const ROUND_MONEY_PATTERN = /(?<![\w.])\d{3,}00(?!\d)/g;

function stripComments(source) {
  // Remove comentários de bloco e de linha antes de rodar os padrões — não queremos que
  // documentação/decisões de engenharia (que citam números como "M6-96" ou datas) disparem
  // falso positivo.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function scanFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const stripped = stripComments(raw).split('\n');
  const findings = [];

  stripped.forEach((line, idx) => {
    const originalLine = lines[idx] || '';
    if (originalLine.includes(ALLOW_MARKER)) return;

    const decimalMatches = line.match(DECIMAL_RATE_PATTERN) || [];
    const moneyMatches = line.match(ROUND_MONEY_PATTERN) || [];
    const allMatches = [...decimalMatches, ...moneyMatches];
    if (allMatches.length > 0) {
      findings.push({ line: idx + 1, matches: allMatches, content: originalLine.trim() });
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
  if (!fs.existsSync(TARGET_DIR)) {
    console.log(`scanConstructionHardcode: diretório ${TARGET_DIR} não existe — nada a verificar.`);
    process.exit(0);
  }

  const files = walk(TARGET_DIR);
  let totalFindings = 0;

  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length > 0) {
      totalFindings += findings.length;
      console.error(`\n${path.relative(process.cwd(), file)}:`);
      findings.forEach((f) => {
        console.error(`  linha ${f.line}: valor(es) suspeito(s) [${f.matches.join(', ')}] -> ${f.content}`);
      });
    }
  }

  if (totalFindings > 0) {
    console.error(
      `\nscanConstructionHardcode: ${totalFindings} ocorrência(s) de possível regra de negócio ` +
        '(percentual/valor monetário) fixada em código dentro de src/features/construction/. ' +
        'Mova o valor para configuração/Motor de Regras, ou marque a linha com "scanner:allow" ' +
        'se for genuinamente inofensivo, explicando o motivo.'
    );
    process.exit(1);
  }

  console.log('scanConstructionHardcode: nenhum hard-code suspeito encontrado em src/features/construction/.');
  process.exit(0);
}

main();
