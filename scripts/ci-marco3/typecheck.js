#!/usr/bin/env node
'use strict';

/**
 * Etapa `typecheck` da esteira do Marco 3 (Guia M3 §16). O código é JavaScript (sem TypeScript): a checagem possível, no padrão da
 * esteira do Financeiro (scripts/financeiro/ci/typecheck.js), é `node --check` (sintaxe) de cada arquivo de Pessoas, Imóveis, CRM e
 * Radar, dos scripts da esteira e da carga, mais o carregamento real (`require`) de cada serviço e rota, que pega `require` quebrado,
 * nome exportado errado e dependência circular antes da suíte. Sai com 1 se algum arquivo não passar.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const MODULOS = ['src/features/people', 'src/features/properties', 'src/features/crm', 'src/features/radar'];
const PASTAS = [...MODULOS, 'scripts/ci-marco3', 'scripts/m3-load'];
const AVULSOS = ['scripts/loadTestMarco3.js', 'src/engines/jobs/radarMatchingJob.js'];

function listar(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listar(path.posix.join(dir, d.name)) : d.name.endsWith('.js') ? [path.posix.join(dir, d.name)] : []));
}

const arquivos = [...PASTAS.flatMap(listar), ...AVULSOS];
let falhas = 0;
for (const f of arquivos) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { falhas += 1; console.error(`REPROVADO node --check ${f}\n${r.stderr}`); }
}
console.log(`[typecheck] node --check em ${arquivos.length} arquivos: ${arquivos.length - falhas} ok, ${falhas} com erro.`);

// Carregamento real dos módulos (sem abrir banco: só require). PORT=0 evita ouvir porta se algum módulo subir app.
process.env.PORT = process.env.PORT || '0';
const modulos = [...MODULOS.flatMap(listar), 'src/engines/jobs/radarMatchingJob.js'];
let naoCarregou = 0;
for (const f of modulos) {
  try { require(path.join(ROOT, f)); } catch (err) { naoCarregou += 1; console.error(`REPROVADO require ${f}: ${err.message}`); }
}
console.log(`[typecheck] require em ${modulos.length} módulos de Pessoas, Imóveis, CRM e Radar: ${modulos.length - naoCarregou} carregaram, ${naoCarregou} falharam.`);
process.exit(falhas || naoCarregou ? 1 : 0);
