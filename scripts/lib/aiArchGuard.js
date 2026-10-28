'use strict';

// Teste de arquitetura da NAY (M9-D001, AI-002 e AI-004; "Não improvisar" do Marco 9).
// Varre src/modules/ai/** e devolve cada violação com arquivo e linha. É uma prova por ausência:
// a NAY não tem SQL livre, shell, eval, escrita em disco, secret manager, adapter bancário de
// execução, string de conexão/role de superusuário, nem SDK de fornecedor de modelo fora de
// `providers/`. Usado pelo CI (scripts/ai-arch-guard.js) e por test/ai/archGuard.test.js.

const fs = require('node:fs');
const path = require('node:path');

const RAIZ_PADRAO = path.join(__dirname, '..', '..', 'src', 'modules', 'ai');

// Pacotes/hosts de fornecedor de modelo: só o diretório providers/ pode tocá-los (AI-002).
const FORNECEDORES = [
  'openai', '@anthropic-ai/', 'anthropic', '@google/generative-ai', '@google-cloud/vertexai',
  '@azure/openai', '@aws-sdk/client-bedrock', 'cohere-ai', '@mistralai/', 'groq-sdk', 'ollama',
  'langchain', '@langchain/', 'llamaindex', 'replicate', '@huggingface/', 'together-ai',
];
const HOSTS_FORNECEDOR = [
  'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com',
  'openai.azure.com', 'bedrock-runtime', 'api.cohere.', 'api.mistral.ai', 'api.groq.com', 'api.together.',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const modulo = (lista) => new RegExp(`(?:require\\(\\s*|from\\s+|import\\s*\\(\\s*)['"\`](?:${lista.map(esc).join('|')})[^'"\`]*['"\`]`);

const REGRAS = [
  { id: 'sql-livre', msg: 'SQL livre (.query/queryInterface/literal) fora de readmodels/ (AI-004)',
    re: /\.\s*query\s*\(|\bsequelize\.literal\s*\(|\bqueryInterface\b/, permitidoEm: ['readmodels'] },
  { id: 'shell', msg: 'import de child_process (shell proibido)', re: modulo(['child_process', 'node:child_process', 'shelljs', 'execa', 'cross-spawn']) },
  { id: 'vm', msg: 'import de vm (execução de código proibida)', re: modulo(['vm', 'node:vm', 'vm2', 'isolated-vm']) },
  { id: 'eval', msg: 'eval / new Function (código dinâmico proibido)', re: /(?<![\w.$])eval\s*\(|\bnew\s+Function\s*\(|(?<![\w.$])Function\s*\(\s*['"`]/ },
  { id: 'fs-escrita', msg: 'escrita em disco (fs de escrita proibido)',
    re: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rm|rename|renameSync|mkdirSync|copyFile|copyFileSync|truncate|truncateSync)\s*\(/,
    soSe: /(?:require\(\s*['"`](?:node:)?fs(?:\/promises)?['"`]|from\s+['"`](?:node:)?fs(?:\/promises)?['"`])/ },
  { id: 'sdk-fornecedor', msg: 'SDK/HTTP de fornecedor de modelo fora de providers/ (AI-002)',
    re: modulo(FORNECEDORES), permitidoEm: ['providers'] },
  { id: 'host-fornecedor', msg: 'host de fornecedor de modelo fora de providers/ (AI-002)',
    re: new RegExp(HOSTS_FORNECEDOR.map(esc).join('|'), 'i'), permitidoEm: ['providers'], comStrings: true },
  { id: 'secret-manager', msg: 'import de secret manager / SecretStore (a NAY nunca lê segredo)',
    re: /(?:require\(\s*|from\s+|import\s*\(\s*)['"`][^'"`]*(?:secretStore|secret-store|secretManager|secrets[-_]?manager|secret-manager|node-vault|integration\/secrets?|settings\/secret)[^'"`]*['"`]/i },
  { id: 'adapter-bancario', msg: 'import de adapter bancário de execução (pagamento/remessa só por workflow humano)',
    re: /(?:require\(\s*|from\s+|import\s*\(\s*)['"`][^'"`]*(?:bank[A-Za-z]*adapter|payment[A-Za-z]*adapter|pix[A-Za-z]*adapter|cnab|correspondent\/[^'"`]*adapter|integration[s]?\/[^'"`]*(?:bank|banco|pix|payment))[^'"`]*['"`]/i },
  { id: 'superusuario', msg: 'string de conexão, role dono/superusuário ou bypass de RLS (AI-004)',
    re: /postgres(?:ql)?:\/\/|\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b|\bSET\s+SESSION\s+AUTHORIZATION\b|\bBYPASSRLS\b|\bSUPERUSER\b|process\.env\.(?:DATABASE_URL|DB_OWNER\w*|DB_ADMIN\w*|MIGRATION\w*|PGUSER|PGPASSWORD)|new\s+Sequelize\s*\(|\bpg\.(?:Pool|Client)\b|new\s+(?:Pool|Client)\s*\(\s*\{/i,
    comStrings: true },
];

function limparComentarios(codigo, manterStrings) {
  // Remove comentários preservando as quebras de linha (a linha reportada continua correta).
  let saida = '';
  let i = 0;
  const n = codigo.length;
  let estado = null;
  while (i < n) {
    const c = codigo[i];
    const d = codigo[i + 1];
    if (estado === null) {
      if (c === '/' && d === '/') { estado = 'linha'; i += 2; continue; }
      if (c === '/' && d === '*') { estado = 'bloco'; i += 2; continue; }
      if (c === '\'' || c === '"' || c === '`') { estado = c; saida += c; i += 1; continue; }
      saida += c; i += 1; continue;
    }
    if (estado === 'linha') { if (c === '\n') { estado = null; saida += c; } i += 1; continue; }
    if (estado === 'bloco') { if (c === '*' && d === '/') { estado = null; i += 2; continue; } if (c === '\n') saida += c; i += 1; continue; }
    // dentro de string/template
    if (c === '\\') { saida += c + (d || ''); i += 2; continue; }
    if (c === estado) { estado = null; saida += c; i += 1; continue; }
    saida += c; i += 1;
  }
  return manterStrings ? saida : saida;
}

function listarArquivos(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listarArquivos(p));
    else if (/\.(?:js|cjs|mjs|ts|json)$/.test(e.name) && e.name !== 'package-lock.json') out.push(p);
  }
  return out;
}

function varrer(raiz = RAIZ_PADRAO) {
  const violacoes = [];
  for (const arquivo of listarArquivos(raiz)) {
    if (arquivo.endsWith('.json')) continue;
    const rel = path.relative(raiz, arquivo).split(path.sep);
    const codigo = limparComentarios(fs.readFileSync(arquivo, 'utf8'));
    const linhas = codigo.split('\n');
    for (const regra of REGRAS) {
      if (regra.permitidoEm && regra.permitidoEm.includes(rel[0])) continue;
      if (regra.soSe && !regra.soSe.test(codigo)) continue;
      linhas.forEach((linha, idx) => {
        if (regra.re.test(linha)) {
          violacoes.push({ regra: regra.id, arquivo: path.relative(process.cwd(), arquivo), linha: idx + 1, mensagem: regra.msg, trecho: linha.trim().slice(0, 160) });
        }
      });
    }
  }
  return violacoes;
}

// Princípio AI-002 fora da NAY: nenhum arquivo do ERP (fora de src/modules/ai/providers/) importa SDK
// de fornecedor de modelo nem chama o host dele.
function varrerSdkFornecedorNoRestoDoCodigo(srcRaiz = path.join(__dirname, '..', '..', 'src')) {
  const violacoes = [];
  const permitido = path.join(srcRaiz, 'modules', 'ai', 'providers') + path.sep;
  const regraSdk = modulo(FORNECEDORES);
  const regraHost = new RegExp(HOSTS_FORNECEDOR.map(esc).join('|'), 'i');
  for (const arquivo of listarArquivos(srcRaiz)) {
    if (arquivo.endsWith('.json') || (arquivo + path.sep).startsWith(permitido) || arquivo.startsWith(permitido)) continue;
    const linhas = limparComentarios(fs.readFileSync(arquivo, 'utf8')).split('\n');
    linhas.forEach((linha, idx) => {
      if (regraSdk.test(linha) || regraHost.test(linha)) {
        violacoes.push({ regra: 'sdk-fornecedor-fora-do-adapter', arquivo: path.relative(path.join(srcRaiz, '..'), arquivo), linha: idx + 1, mensagem: 'SDK/HTTP de fornecedor de modelo fora de src/modules/ai/providers/ (AI-002)', trecho: linha.trim().slice(0, 160) });
      }
    });
  }
  return violacoes;
}

function formatar(violacoes) {
  return violacoes.map((v) => `${v.arquivo}:${v.linha} [${v.regra}] ${v.mensagem} -> ${v.trecho}`).join('\n');
}

module.exports = { varrer, varrerSdkFornecedorNoRestoDoCodigo, formatar, limparComentarios, listarArquivos, RAIZ_PADRAO, REGRAS };
