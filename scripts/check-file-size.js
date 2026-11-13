'use strict';

/**
 * Guarda contra arquivo grande demais ("god file") nas áreas do Marco 9.
 * Reprova (exit 1) qualquer arquivo .js acima do limite de linhas, para forçar uma
 * responsabilidade por arquivo. O limite padrão é 400 linhas; pode ser ajustado com
 * --max=<n> ou FILE_SIZE_MAX. Uso: node scripts/check-file-size.js [pasta ...]
 *
 * Sem argumentos também varre as migrations do Marco 9 (número >= MIGRATION_MIN) e os testes do Marco 9
 * (m9d*, analytics.*, marketing*, test/ai, test/integrations e test/helpers); testes antigos de outros marcos ficam de fora.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIRS = [
  'src/features/ai',
  'src/features/core-governance',
  'src/features/integrations',
  'src/features/marketing',
  'src/features/analytics',
  'src/modules/finance', // M4-D140: o Financeiro inteiro na árvore do Guia M4 §2, inclusive as migrations da pasta do módulo
];

// Migrations do Marco 9 começam em 20260101000650 (as de BI, em 20260101009600, já estão acima).
const MIGRATION_MIN = 20260101000650;
const TEST_TOP_LEVEL = /^(m9d|analytics\.|marketing).*\.js$/;

const maxArg = process.argv.find((a) => a.startsWith('--max='));
const MAX = Number((maxArg && maxArg.slice(6)) || process.env.FILE_SIZE_MAX || 400);
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function walk(dir, out, accept) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out, accept);
    } else if (entry.name.endsWith('.js') && (!accept || accept(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const numeroDaMigration = (nome) => Number((nome.match(/^(\d+)-/) || [])[1]);

// Cada alvo: pasta, se desce nas subpastas e filtro opcional por nome de arquivo.
const ALVOS_PADRAO = [
  ...DEFAULT_DIRS.map((dir) => ({ dir })),
  { dir: 'migrations', accept: (nome) => numeroDaMigration(nome) >= MIGRATION_MIN },
  { dir: 'test', flat: true, accept: (nome) => TEST_TOP_LEVEL.test(nome) },
  { dir: 'test/ai' },
  { dir: 'test/integrations' },
  { dir: 'test/helpers' },
];
const alvos = dirs.length ? dirs.map((dir) => ({ dir })) : ALVOS_PADRAO;

const grandes = [];
let total = 0;
for (const { dir, flat, accept } of alvos) {
  const alvo = path.resolve(ROOT, dir);
  const arquivos = flat
    ? (fs.existsSync(alvo) ? fs.readdirSync(alvo, { withFileTypes: true }) : [])
        .filter((e) => e.isFile() && e.name.endsWith('.js') && accept(e.name))
        .map((e) => path.join(alvo, e.name))
    : walk(alvo, [], accept);
  for (const file of arquivos) {
    total += 1;
    const linhas = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').length;
    if (linhas > MAX) grandes.push({ file: path.relative(ROOT, file), linhas });
  }
}

if (grandes.length) {
  console.error(`Arquivos acima de ${MAX} linhas (separe por responsabilidade):`);
  for (const g of grandes) console.error(`  ${g.linhas}  ${g.file}`);
  process.exit(1);
}
console.log(`OK: ${total} arquivos, nenhum acima de ${MAX} linhas.`);
