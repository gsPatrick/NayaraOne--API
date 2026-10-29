'use strict';

/**
 * Fronteiras do módulo de integrações (M9-D210, regras 1 a 5 do item 3.2) e verificação de certificado (M9-D244 3.1).
 * Lê o código-fonte (sem executar nada), devolve cada violação com arquivo e linha e não aceita lista de exceções:
 * exceção = falha. Usado pelo CI (scripts/checkIntegrationBoundaries.js) e pelos testes de arquitetura.
 *
 * Códigos: ARCH_SDK_OUTSIDE_ADAPTER, ARCH_HTTP_OUTSIDE_CLIENT, ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL,
 * ARCH_PROVIDER_IMPORTS_DOMAIN, ARCH_TLS_VERIFICATION_DISABLED.
 */
const fs = require('node:fs');
const path = require('node:path');
const { limparComentarios, listarArquivos, REGRAS } = require('./aiArchGuard');
const { DEFAULT_SDK_DENYLIST, isSdkPackage, isHttpLibrary } = require('../../src/features/integrations/http/sdkPolicy');

const API_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(API_ROOT, 'src');

// Quem fala TLS/HTTP por conta própria: só o cliente único e o transporte dele (utils/resilientFetch.js, que só o cliente importa).
const HTTP_ALLOWED = ['features/integrations/http/', 'utils/resilientFetch.js'];
const RAW_HTTP_MODULES = /^(?:node:)?https?$|^(?:node:)?http2$/;
const IMPORT_RE = /(?:require\(\s*|\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"`]([^'"`]+)['"`]/g;
const FETCH_RE = /(?<![\w.$])fetch\s*\(|\b(?:globalThis|global|window|self)\s*\.\s*fetch\s*\(/;
const AI_SDK_RE = REGRAS.find((r) => r.id === 'sdk-fornecedor').re;
const norm = (p) => p.split(path.sep).join('/');

function importsOf(linha) {
  const specs = [];
  IMPORT_RE.lastIndex = 0;
  let m = IMPORT_RE.exec(linha);
  while (m) { specs.push(m[1]); m = IMPORT_RE.exec(linha); }
  return specs;
}

const dentro = (alvo, pasta) => alvo === pasta || alvo.startsWith(pasta + path.sep);

/** Pastas do módulo, derivadas da raiz `src` informada (a fixture dos testes usa outra raiz). */
function layout(srcRoot) {
  const integ = path.join(srcRoot, 'features', 'integrations');
  return { srcRoot, integ, providers: path.join(integ, 'providers'), aiProviders: path.join(srcRoot, 'features', 'ai', 'providers'), barrel: path.join(integ, 'index.js') };
}

const isBarrel = (alvo, L) => alvo === L.integ || alvo === L.barrel || alvo === path.join(L.integ, 'index');

/** `providers/<dominio>/<nome>/arquivo.js`: o adapter de um fornecedor (os ports ficam em providers/<dominio>/*.port.js). */
function adapterDomain(arquivo, L) {
  if (!dentro(arquivo, L.providers)) return null;
  const partes = path.relative(L.providers, arquivo).split(path.sep);
  return partes.length >= 3 ? partes[0] : null;
}

function permitidoParaAdapter(alvo, dominio, L) {
  const ok = ['registry', 'http', 'secrets'].map((p) => path.join(L.integ, p));
  ok.push(path.join(L.providers, dominio), path.join(L.providers, 'ports'));
  return ok.some((pasta) => dentro(alvo, pasta));
}

function checarLinha({ arquivo, rel, linha, texto, L, denylist }) {
  const achados = [];
  const falha = (code, message) => achados.push({ code, file: rel, line: linha, message, snippet: texto.trim().slice(0, 160) });
  const emIntegProviders = dentro(arquivo, L.providers);
  const emAiProviders = dentro(arquivo, L.aiProviders);
  const emHttp = HTTP_ALLOWED.some((p) => rel.startsWith(`src/${p}`) || norm(path.relative(L.srcRoot, arquivo)).startsWith(p));
  for (const spec of importsOf(texto)) {
    if (isSdkPackage(spec, denylist) && !emIntegProviders) falha('ARCH_SDK_OUTSIDE_ADAPTER', 'Pacote de fornecedor importado fora de um adaptador.');
    if (AI_SDK_RE.test(`require('${spec}')`) && !emAiProviders) falha('ARCH_SDK_OUTSIDE_ADAPTER', 'SDK de modelo de IA importado fora de src/features/ai/providers.');
    if (isHttpLibrary(spec) || (RAW_HTTP_MODULES.test(spec) && !emHttp)) falha('ARCH_HTTP_OUTSIDE_CLIENT', 'Biblioteca HTTP importada fora do IntegrationHttpClient.');
    if (spec.startsWith('.')) {
      const alvo = path.resolve(path.dirname(arquivo), spec);
      if (/(^|[\\/])resilientFetch(\.js)?$/.test(spec) && !dentro(arquivo, path.join(L.integ, 'http'))) falha('ARCH_HTTP_OUTSIDE_CLIENT', 'resilientFetch só pode ser usado pelo IntegrationHttpClient.');
      if (!dentro(arquivo, L.integ) && dentro(alvo, L.providers)) falha('ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL', 'Importação de dentro de integrations/providers sem passar pelo index.js do módulo.');
      if (emAiProviders && dentro(alvo, L.integ) && !isBarrel(alvo, L)) falha('ARCH_PROVIDER_IMPORT_OUTSIDE_BARREL', 'O adapter de IA importa o contrato de integrações só pelo index.js do módulo.');
      const dominio = adapterDomain(arquivo, L);
      if (dominio && !permitidoParaAdapter(alvo, dominio, L)) falha('ARCH_PROVIDER_IMPORTS_DOMAIN', 'O adapter importa só de registry, http, secrets e do próprio port.');
    }
  }
  if (!emHttp && FETCH_RE.test(texto)) falha('ARCH_HTTP_OUTSIDE_CLIENT', 'Chamada HTTP externa (fetch) fora do IntegrationHttpClient.');
  return achados;
}

/** Varre `srcRoot` e devolve as violações de fronteira. */
function scanBoundaries({ srcRoot = SRC_ROOT, denylist = DEFAULT_SDK_DENYLIST } = {}) {
  const L = layout(srcRoot);
  const projeto = path.dirname(srcRoot);
  const violacoes = [];
  for (const arquivo of listarArquivos(srcRoot)) {
    if (arquivo.endsWith('.json')) continue;
    const rel = norm(path.relative(projeto, arquivo));
    limparComentarios(fs.readFileSync(arquivo, 'utf8')).split('\n').forEach((texto, idx) => {
      violacoes.push(...checarLinha({ arquivo, rel, linha: idx + 1, texto, L, denylist }));
    });
  }
  return violacoes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

// Padrões montados com \s* para o próprio guarda não casar com o texto dele.
const TLS_PATTERNS = [/rejectUnauthorized\s*:\s*false/, /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0\b/];
// A conexão com o banco de dados (src/config) é outro assunto: o D244 trata o tráfego com fornecedor (DI-D244-1).
const TLS_SKIP_DIRS = ['config'];

function tlsFiles(projectRoot, srcRoot) {
  const arquivos = listarArquivos(srcRoot).filter((f) => !TLS_SKIP_DIRS.some((d) => dentro(f, path.join(srcRoot, d))));
  const extras = [path.join(projectRoot, 'app.js'), path.join(projectRoot, 'Dockerfile'), path.join(projectRoot, '.env.example')];
  const workflows = path.join(projectRoot, '.github', 'workflows');
  if (fs.existsSync(workflows)) fs.readdirSync(workflows).forEach((n) => extras.push(path.join(workflows, n)));
  return [...arquivos, ...extras.filter((f) => fs.existsSync(f))];
}

/** Procura o desligamento da verificação de certificado (M9-D244 3.1) no código, no Dockerfile, no .env de exemplo e no CI. */
function scanTlsVerification({ projectRoot = API_ROOT, srcRoot = path.join(projectRoot, 'src') } = {}) {
  const violacoes = [];
  for (const arquivo of tlsFiles(projectRoot, srcRoot)) {
    fs.readFileSync(arquivo, 'utf8').split('\n').forEach((texto, idx) => {
      if (TLS_PATTERNS.some((re) => re.test(texto))) {
        violacoes.push({ code: 'ARCH_TLS_VERIFICATION_DISABLED', file: norm(path.relative(projectRoot, arquivo)), line: idx + 1, message: 'A verificação de certificado não pode ser desligada.', snippet: texto.trim().slice(0, 160) });
      }
    });
  }
  return violacoes;
}

const formatar = (v) => v.map((x) => `${x.file}:${x.line} [${x.code}] ${x.message} -> ${x.snippet}`).join('\n');

module.exports = { scanBoundaries, scanTlsVerification, formatar, SRC_ROOT, API_ROOT };
