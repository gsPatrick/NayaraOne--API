#!/usr/bin/env node
'use strict';

/**
 * Estágio 2 (typecheck) da esteira do Financeiro. O projeto é JavaScript (sem TypeScript): a checagem possível é `node --check` (sintaxe) de cada arquivo
 * do módulo financeiro, dos scripts da esteira e dos testes do Financeiro, mais o carregamento real de cada serviço/rota (pega `require` quebrado, nome
 * exportado errado e dependência circular antes da suíte). Sai com 1 no primeiro arquivo que não passa.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const PASTAS = ['src/modules/finance', 'scripts/financeiro', 'scripts/restoreDrill'];
const TESTES = /^(finance\.|marco4\.|m4\.|m45\.|adversarial\.finance|financeE2E|nayaraConferencia1810|nayaraExternalAuditMatrixM4|frente3\.financeRules|ciTwoTenantsFinanceLegal|bankPayment)/;

function listar(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listar(path.posix.join(dir, d.name)) : d.name.endsWith('.js') ? [path.posix.join(dir, d.name)] : []));
}

const arquivos = [...PASTAS.flatMap(listar), ...fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js') && TESTES.test(f)).map((f) => `test/${f}`)];
let falhas = 0;
for (const f of arquivos) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { falhas += 1; console.error(`REPROVADO node --check ${f}\n${r.stderr}`); }
}
console.log(`[typecheck] node --check em ${arquivos.length} arquivos: ${arquivos.length - falhas} ok, ${falhas} com erro.`);

// Carregamento real dos módulos do Financeiro (sem abrir banco: só require). PORT=0 evita ouvir porta se algum módulo subir app.
process.env.PORT = process.env.PORT || '0';
// Guia M4 §2: domínio, serviços, repositórios, porta/provedores do banco, HTTP e workers (o hub do banco e as migrations não são carregados soltos).
const modulos = listar('src/modules/finance').filter((f) => !/\/infrastructure\/db\/migrations\/|\/infrastructure\/bank\/hub\//.test(f));
let naoCarregou = 0;
for (const f of modulos) {
  try { require(path.join(ROOT, f)); } catch (err) { naoCarregou += 1; console.error(`REPROVADO require ${f}: ${err.message}`); }
}
console.log(`[typecheck] require em ${modulos.length} módulos de src/modules/finance: ${modulos.length - naoCarregou} carregaram, ${naoCarregou} falharam.`);
process.exit(falhas || naoCarregou ? 1 : 0);
