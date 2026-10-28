'use strict';

/**
 * Guarda contra arquivo grande demais ("god file") nas áreas do Marco 9.
 * Reprova (exit 1) qualquer arquivo .js acima do limite de linhas, para forçar uma
 * responsabilidade por arquivo. O limite padrão é 400 linhas; pode ser ajustado com
 * --max=<n> ou FILE_SIZE_MAX. Uso: node scripts/check-file-size.js [pasta ...]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIRS = [
  'src/modules',
  'src/features/integrations',
  'src/features/marketing',
  'src/features/analytics',
];

const maxArg = process.argv.find((a) => a.startsWith('--max='));
const MAX = Number((maxArg && maxArg.slice(6)) || process.env.FILE_SIZE_MAX || 400);
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const alvos = (dirs.length ? dirs : DEFAULT_DIRS).map((d) => path.resolve(ROOT, d));
const grandes = [];
let total = 0;
for (const alvo of alvos) {
  for (const file of walk(alvo, [])) {
    total += 1;
    const linhas = fs.readFileSync(file, 'utf8').split('\n').length;
    if (linhas > MAX) grandes.push({ file: path.relative(ROOT, file), linhas });
  }
}

if (grandes.length) {
  console.error(`Arquivos acima de ${MAX} linhas (separe por responsabilidade):`);
  for (const g of grandes) console.error(`  ${g.linhas}  ${g.file}`);
  process.exit(1);
}
console.log(`OK: ${total} arquivos, nenhum acima de ${MAX} linhas.`);
