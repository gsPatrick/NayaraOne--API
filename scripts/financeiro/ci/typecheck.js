#!/usr/bin/env node
'use strict';

/**
 * Estágio 2 (typecheck) da esteira do Financeiro (Guia M4 §17). O projeto é JavaScript: a checagem de TIPOS é `tsc --checkJs` (TypeScript 5.6.3, devDependency)
 * com `strict` sobre todo src/modules/finance (domínio, serviços, repositórios, banco, HTTP, workers e migrations), configurada em
 * scripts/financeiro/ci/typecheck/tsconfig.json — mesmo padrão de scripts/int-ci/typecheck e scripts/marketing/ci/typecheck. Os tipos vêm do próprio código
 * (inferência entre os arquivos do módulo) e de JSDoc; o que vem de fora do módulo entra como `any` (noResolve). Depois, como passos adicionais:
 * `node --check` dos scripts da esteira e dos testes do Financeiro, e o carregamento real (require) de cada módulo (pega `require` quebrado, nome exportado errado
 * e dependência circular antes da suíte). Sai com 1 se qualquer passo reprovar.
 *
 * `--tsconfig <arquivo>` troca a configuração do tsc (usado pelo teste da esteira para provar que um erro de tipo de verdade reprova o estágio).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const TSCONFIG_PADRAO = path.join(__dirname, 'typecheck', 'tsconfig.json');
const PASTAS_SINTAXE = ['scripts/financeiro', 'scripts/restoreDrill'];
const TESTES = /^(finance\.|marco4\.|m4\.|m45\.|adversarial\.finance|financeE2E|nayaraConferencia1810|nayaraExternalAuditMatrixM4|frente3\.financeRules|ciTwoTenantsFinanceLegal|bankPayment)/;

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : null;
}

function listar(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listar(path.posix.join(dir, d.name)) : d.name.endsWith('.js') ? [path.posix.join(dir, d.name)] : []));
}

// 1. Tipos: tsc --checkJs (strict) em todo src/modules/finance.
const tsconfig = path.resolve(ROOT, argumento('--tsconfig') || TSCONFIG_PADRAO);
const tsc = require.resolve('typescript/bin/tsc', { paths: [ROOT] });
const r = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const errosTipo = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /error TS\d+/.test(l));
if (r.status !== 0) {
  console.error(`${r.stdout || ''}${r.stderr || ''}`);
  console.error(`REPROVADO tsc --checkJs (${path.relative(ROOT, tsconfig)}): ${errosTipo.length} erro(s) de tipo.`);
}
console.log(`[typecheck] tsc --checkJs strict (${path.relative(ROOT, tsconfig)}): ${r.status === 0 ? 'sem erro de tipo' : `${errosTipo.length} erro(s)`}.`);

// 2. Sintaxe dos scripts da esteira e dos testes do Financeiro (fora do escopo do tsc).
const arquivos = [...PASTAS_SINTAXE.flatMap(listar), ...fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js') && TESTES.test(f)).map((f) => `test/${f}`)];
let falhas = 0;
for (const f of arquivos) {
  const s = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
  if (s.status !== 0) { falhas += 1; console.error(`REPROVADO node --check ${f}\n${s.stderr}`); }
}
console.log(`[typecheck] node --check em ${arquivos.length} arquivos: ${arquivos.length - falhas} ok, ${falhas} com erro.`);

// 3. Carregamento real dos módulos do Financeiro (sem abrir banco: só require). PORT=0 evita ouvir porta se algum módulo subir app.
process.env.PORT = process.env.PORT || '0';
// Guia M4 §2: domínio, serviços, repositórios, porta/provedores do banco, HTTP e workers (o hub do banco e as migrations não são carregados soltos).
const modulos = listar('src/modules/finance').filter((f) => !/\/infrastructure\/db\/migrations\/|\/infrastructure\/bank\/hub\//.test(f));
let naoCarregou = 0;
for (const f of modulos) {
  try { require(path.join(ROOT, f)); } catch (/** @type {any} */ err) { naoCarregou += 1; console.error(`REPROVADO require ${f}: ${err.message}`); }
}
console.log(`[typecheck] require em ${modulos.length} módulos de src/modules/finance: ${modulos.length - naoCarregou} carregaram, ${naoCarregou} falharam.`);
process.exit(r.status !== 0 || falhas || naoCarregou ? 1 : 0);
