#!/usr/bin/env node
'use strict';
/**
 * Gerador da página de entrega dos Marcos 4 e 5 (public/marco4-5.html do Front).
 *
 * Fluxo da entrega:  commit → push (Patrick) → CI → este gerador com os RUN_IDs reais → deploy (Patrick).
 *
 *   node scripts/gerar-entrega-marco45.js --api-run <RUN_ID_API> --front-run <RUN_ID_FRONT> \
 *        [--prints ~/Downloads/evidencias_m45p] [--out ../NayaraOne--FRONT/public/marco4-5.html]
 *
 * O que ele faz com os RUN_IDs: `gh run view` (commit, evento, conclusão), `gh run download` do
 * artifact test-results-<commit> da API, SANEIA o log (scripts/sanear-log-teste.js), grava o log
 * saneado e o sha256 do original e do saneado em docs/evidencias/ci/, guarda o original FORA do
 * repositório (--originais-dir) e regenera a página inteira: matriz dos 39 grupos com o resultado
 * individual de cada teste lido do log do commit final, F01–F06 (antes/depois), matriz do caderno,
 * capturas HTTP e consultas SQL do banco descartável, metas e hashes.
 *
 * Sem RUN_IDs (ou com --placeholder) a página sai com o marcador CI_FINAL e TODOS os testes como
 * "aguardando CI do commit final": nada é marcado aprovado sem o log do CI.
 *
 * Opções avançadas: --log-ci <arquivo> (usa um log já baixado em vez de gh), --log-local <arquivo>,
 * --captura <json>, --api-commit <sha>, --front-commit <sha>, --repo-api, --repo-front.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseLog } = require('./lib/entregaMarco45/parseLog');
const { sanearLog, sha256 } = require('./lib/sanearLog');
const R = require('./lib/entregaMarco45/render');

const API_ROOT = path.join(__dirname, '..');
const DOCS = path.join(API_ROOT, 'docs');
const ENT = path.join(DOCS, 'entrega-marco45');
const CI_DIR = path.join(DOCS, 'evidencias', 'ci');

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--placeholder') o.placeholder = true;
    else if (a.startsWith('--')) { o[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return o;
}
const opt = args(process.argv);
const REPO_API = opt['repo-api'] || 'gsPatrick/NayaraOne--API';
const REPO_FRONT = opt['repo-front'] || 'gsPatrick/NayaraOne--FRONT';
const OUT = opt.out || path.join(API_ROOT, '..', 'NayaraOne--FRONT', 'public', 'marco4-5.html');
const ORIGINAIS = opt['originais-dir'] || path.join(API_ROOT, '..', '_backups', 'logs-originais-com-token');
const PRINTS_DIR = (opt.prints || path.join(os.homedir(), 'Downloads', 'evidencias_m45p')).replace(/^~/, os.homedir());

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const lerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function runInfo(repo, id) {
  const j = JSON.parse(gh('run', 'view', String(id), '-R', repo, '--json', 'headSha,conclusion,event,createdAt,url,headBranch,status,databaseId'));
  return { id: String(id), repo, sha: j.headSha, conclusao: j.conclusion, status: j.status, evento: j.event, criadoEm: j.createdAt, url: j.url, branch: j.headBranch };
}

function baixarLogCI(info) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-art-'));
  gh('run', 'download', info.id, '-R', info.repo, '-D', tmp, '-p', 'test-results-*');
  const achar = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? achar(path.join(d, e.name)) : [path.join(d, e.name)]));
  const arq = achar(tmp).find((f) => path.basename(f) === 'test-results.log');
  if (!arq) throw new Error('artifact test-results.log não encontrado no run ' + info.id);
  return arq;
}

function guardarLogSaneado(originalPath, nomeBase) {
  const original = fs.readFileSync(originalPath, 'utf8');
  const r = sanearLog(original, { nomeOriginal: path.basename(nomeBase) });
  fs.mkdirSync(ORIGINAIS, { recursive: true });
  fs.copyFileSync(originalPath, path.join(ORIGINAIS, nomeBase));
  const destino = path.join(CI_DIR, nomeBase);
  fs.writeFileSync(destino, r.texto);
  fs.writeFileSync(`${destino}.sha256`, `${r.shaSaneado}  ${nomeBase}\n`);
  const sanFile = path.join(CI_DIR, 'SANEAMENTO.json');
  const san = fs.existsSync(sanFile) ? lerJson(sanFile) : { arquivos: [] };
  san.arquivos = san.arquivos.filter((x) => x.arquivo !== nomeBase);
  const { texto, ...res } = r;
  san.arquivos.push({ arquivo: nomeBase, ...res });
  fs.writeFileSync(sanFile, `${JSON.stringify(san, null, 2)}\n`);
  return { ...r, caminho: destino, nome: nomeBase };
}

function lerLogSaneado(arquivo) {
  const original = fs.readFileSync(arquivo, 'utf8');
  if (original.startsWith('# SANEADO')) {
    const m = /sha256 do original: ([0-9a-f]{64})/.exec(original);
    return { texto: original, shaSaneado: sha256(Buffer.from(original, 'utf8')), shaOriginal: m ? m[1] : 'não informado', nome: path.basename(arquivo) };
  }
  const r = sanearLog(original, { nomeOriginal: path.basename(arquivo) });
  return { ...r, nome: path.basename(arquivo) };
}

function maisRecente(padrao) {
  const arqs = fs.readdirSync(CI_DIR).filter((f) => padrao.test(f)).map((f) => ({ f, t: fs.statSync(path.join(CI_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return arqs.length ? path.join(CI_DIR, arqs[0].f) : null;
}

// ---------------------------------------------------------------- prints do Claude Browser
function lerPrints(dir) {
  if (!fs.existsSync(dir)) return null;
  const jpgs = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
  if (!jpgs.length) return null;
  const vistos = new Map();
  const itens = [];
  for (const f of jpgs) {
    const buf = fs.readFileSync(path.join(dir, f));
    const sha = sha256(buf);
    const m = /^(F0[1-6]|\d{2})_/.exec(f);
    const item = { arquivo: f, sha, bytes: buf.length, chave: m ? (m[1].startsWith('F') ? m[1] : String(Number(m[1]))) : null, duplicadoDe: vistos.get(sha) || null, b64: buf.toString('base64') };
    if (!vistos.has(sha)) vistos.set(sha, f);
    itens.push(item);
  }
  const rel = path.join(dir, 'relatorio.md');
  return { dir, itens, relatorio: fs.existsSync(rel) ? fs.readFileSync(rel, 'utf8') : null };
}

// ---------------------------------------------------------------- montagem
function montar() {
  const base = lerJson(path.join(ENT, 'base.json'));
  const capFile = opt.captura || path.join(ENT, 'captura-descartavel.json');
  const cap = fs.existsSync(capFile) ? lerJson(capFile) : { meta: null, usuarios: [], passos: [], consultas: [] };
  const antesJson = fs.existsSync(path.join(ENT, 'antes-46b0ecb.json')) ? lerJson(path.join(ENT, 'antes-46b0ecb.json')) : null;
  const antes = antesJson ? new Map(antesJson.testes.map((t) => [t.nome, t])) : null;

  // ---- CI final
  let ciInfo = null; let frontInfo = null; let ciLog = null;
  if (!opt.placeholder && opt['api-run']) {
    ciInfo = runInfo(REPO_API, opt['api-run']);
    const orig = baixarLogCI(ciInfo);
    ciLog = guardarLogSaneado(orig, `${ciInfo.id}-${ciInfo.sha.slice(0, 7)}-test-results.log`);
    if (opt['front-run']) frontInfo = runInfo(REPO_FRONT, opt['front-run']);
  } else if (!opt.placeholder && opt['log-ci']) {
    ciLog = lerLogSaneado(opt['log-ci']);
  }
  const ci = ciLog ? parseLog(ciLog.texto) : null;
  if (ciInfo && ci && ci.commit && !ci.commit.startsWith(ciInfo.sha.slice(0, 7))) throw new Error(`cabeçalho do log (${ci.commit}) não bate com o commit do run (${ciInfo.sha})`);

  // ---- reprodução local
  const localFile = opt['log-local'] || maisRecente(/^local-reproducao-.*-test-results\.log$/);
  const localLog = localFile ? lerLogSaneado(localFile) : null;
  const local = localLog ? parseLog(localLog.texto) : null;

  const drillFile = path.join(DOCS, 'evidencias', 'marco4-5', 'drill-legal-restore-2026-10-19-badc180.log');
  const drill = fs.existsSync(drillFile) ? fs.readFileSync(drillFile, 'utf8') : null;
  const prints = lerPrints(PRINTS_DIR);

  const apiCommit = (ciInfo && ciInfo.sha) || opt['api-commit'] || (ci && ci.commit) || (local && local.commit) || 'não informado';
  const frontCommit = (frontInfo && frontInfo.sha) || opt['front-commit'] || 'não informado';
  const agora = new Date();

  // ---- classificação dos grupos
  const grupos = base.grupos39.map((g, i) => {
    const n = i + 1;
    const cls = g.testes.map((t) => ({ t, c: R.classificarTeste(ci, t.nome) }));
    const cat = R.pior(cls.map((x) => x.c.cat));
    return { ...g, n, cls, cat };
  });
  const contagem = (lista) => PRIOR_KEYS.map((k) => [k, lista.filter((x) => x.cat === k).length]);
  const PRIOR_KEYS = ['aprovado', 'falhou', 'ausente', 'bloqueado', 'naoimpl', 'aguardando'];
  const porCat = Object.fromEntries(contagem(grupos));
  const matriz = base.matriz.map((r) => {
    const cls = r.testes.map((t) => ({ t, c: R.classificarTeste(ci, t.nome) }));
    return { ...r, cls, cat: R.pior(cls.map((x) => x.c.cat)) };
  });
  const matrizPorCat = Object.fromEntries(contagem(matriz));

  const passosDe = (n) => cap.passos.filter((p) => (p.grupos || []).includes(n));
  const consultasDe = (n) => cap.consultas.filter((c) => (c.grupos || []).includes(n));
  const idsHom = new Set([...base.httpHomologacao, ...base.consultasBancoHomologacao].map((x) => x.id));
  const homologDe = (ids) => (ids || []).filter((id) => idsHom.has(id)).map((id) => `<a href="#hom-${R.esc(id)}">${R.esc(id)}</a>`).join(', ') || 'nenhuma';

  const stat = (n, l, warn) => `<div class="stat"><div class="n${warn ? ' warn' : ''}">${n}</div><div class="l">${R.esc(l)}</div></div>`;
  const resumoCI = ci ? `${ci.resumo.pass}/${ci.resumo.tests}` : 'CI pendente';
  const resumoLocal = local ? `${local.resumo.pass}/${local.resumo.tests}` : 'sem reprodução local';

  // ---- hashes
  const hashLinhas = [];
  if (ciLog) hashLinhas.push(['Log do CI do commit final (saneado)', ciLog.nome, ciLog.shaSaneado, ciLog.shaOriginal]);
  if (localLog) hashLinhas.push(['Reprodução local (saneado)', localLog.nome, localLog.shaSaneado, localLog.shaOriginal]);
  if (antesJson) hashLinhas.push(['F01–F06 antes (commit 46b0ecb, saneado)', 'antes-46b0ecb-test-results.log', antesJson.shaLogSaneado, antesJson.shaLogOriginal]);
  if (drill) hashLinhas.push(['Drill de restore jurídico', path.basename(drillFile), sha256(Buffer.from(drill, 'utf8')), 'log sem token; sem saneamento']);

  const ph = '<span class="ph">CI_FINAL</span>';
  const bannerCI = ci
    ? `Log do CI do commit <code>${R.esc(String(apiCommit).slice(0, 7))}</code>: ${porCat.aprovado} de 39 grupos aprovados, ${porCat.falhou} com falha, ${porCat.ausente} com teste ausente do log, ${porCat.bloqueado} bloqueados por ambiente, ${porCat.naoimpl} não implementados, ${porCat.aguardando} aguardando.`
    : `Ainda não há log de CI do commit final: nenhum grupo é marcado como aprovado. Cada teste fica como "aguardando CI do commit final" até o gerador ser executado com os RUN_IDs reais.`;

  const sanitizacao = [
    'Logs de teste: removidas as linhas de log JSON de requisição da API (começam com {"level":) e qualquer linha com padrão de segredo (cabeçalhos de autorização, tokens e strings de conexão). Nenhuma linha de resultado de teste foi alterada; o SHA-256 do original e do saneado está na tabela de hashes e no cabeçalho de cada log. Os originais ficam fora do repositório.',
    'Nenhum caractere do base64 foi trocado: as imagens e os dados são gravados como são.',
    'Corpos de resposta HTTP: gravados como vieram da API (campos vazios preservados como vieram, nada truncado, nada traduzido). Únicas alterações: access token, refresh token e credenciais viram [REDACTED]; e-mails reais de usuários de homologação foram trocados por e-mails fictícios (@exemplo.test) nos dados da homologação.',
    'Textos: o nome do provedor de hospedagem foi trocado por "servidor de homologação"; rótulos de ambiente e nomes de usuários de teste da conferência foram mantidos.',
    'Datas 2070 e 2071 (e competências como 03/2071) são meses futuros usados só como dados de teste, para não colidir com meses reais.',
    'Datas e horas nas tabelas aparecem em formato brasileiro (horário de Brasília); o formato ISO fica apenas dentro dos blocos JSON brutos.',
    'O banco descartável usa um GRANT amplo para a role da suíte (como o workflow do CI); a imutabilidade da trilha de auditoria vem dos gatilhos do banco, e a ausência de UPDATE/DELETE no runtime de produção está nas consultas de homologação.',
  ];

  // ===================================================== HTML
  const navBase = [['estado', '1. Estado'], ['reproducao', '2. Reprodução'], ['grupos', '3. 39 grupos'], ['respostas', '4. F01–F06'], ['matriz', '5. Matriz do caderno'], ['logs', '6. Logs'], ['http', '7. HTTP no banco descartável'], ['sql', '8. Consultas SQL'], ['homologacao', '9. Homologação'], ['reconf', '11. Reconferência de 19/10'], ['anexo-json', '12. Anexo JSON'], ['conferir', '13. Como conferir'], ['fora', '14. Limites']];

  const nav = prints ? navBase.slice(0, 9).concat([['prints', '10. Prints ao vivo']], navBase.slice(9)) : navBase;
  const parts = [];
  parts.push(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Marcos 4 e 5 — Entrega</title><style>${R.estilo()}</style></head><body><div class="wrap">`);
  parts.push(`<header class="top"><div class="tag">Nayara One · Execução reproduzível dos Marcos 4 e 5</div><h1>Centro Financeiro Inteligente · Contratos, Locação, Vistorias e Jurídico</h1>
<div class="meta"><span><b>Gerada em:</b> ${R.dataBR(agora)}</span><span><b>Autor:</b> Patrick Siqueira (desenvolvedor)</span><span><b>Base:</b> ${R.esc(base.meta.base)}</span><span><b>Versão:</b> API <code>${R.esc(String(apiCommit).slice(0, 7))}</code> · Front <code>${R.esc(String(frontCommit).slice(0, 7))}</code></span>
<span><b>CI do commit final:</b> ${ciInfo ? `API <a href="${R.esc(ciInfo.url)}">run ${R.esc(ciInfo.id)}</a> (${R.esc(ciInfo.evento)}, ${R.esc(ciInfo.conclusao || ciInfo.status)}, ${R.dataBR(ciInfo.criadoEm)})` : ph}${frontInfo ? ` · Front <a href="${R.esc(frontInfo.url)}">run ${R.esc(frontInfo.id)}</a> (${R.esc(frontInfo.evento)}, ${R.esc(frontInfo.conclusao || frontInfo.status)})` : ''}</span></div>
<div class="status"><span class="b ${ci && porCat.aprovado === 39 ? 'ok' : 'warn'} big">Execução reproduzível, não declaração de aceite</span><span>${bannerCI}</span></div>
<div class="summary"><p>1. Esta página é gerada por <code>scripts/gerar-entrega-marco45.js</code> a partir do log do CI do commit indicado. Cada teste mostra o resultado individual lido do log; o que o log não mostra não é marcado como aprovado.</p><p>2. Categorias: aprovado, falhou, bloqueado por ambiente (teste pulado), não implementado (teste marcado como pendente de implementação) e aguardando CI do commit final.</p><p>3. As provas por HTTP e por consulta SQL foram colhidas num PostgreSQL 16 descartável, com migrations do zero e o seed de dois tenants fictícios (perfis maker, checker, leitura, gestor e o tenant B).</p><p>4. F01 a F06 têm seção própria, com cada teste ligado ao seu resultado no log e ao seu estado antes das correções.</p><p>5. Os logs, os JSON e os hashes estão embutidos na própria página, legíveis sem JavaScript, com botão de download.</p></div></header>`);
  parts.push(`<nav class="toc" aria-label="Índice">${nav.map(([id, t]) => `<a href="#${id}">${R.esc(t)}</a>`).join('')}</nav>`);
  parts.push(`<div class="stats">${stat(`${porCat.aprovado}/39`, 'Grupos aprovados pelo log do CI', porCat.aprovado !== 39)}${stat(porCat.falhou + porCat.ausente, 'Grupos com falha ou teste ausente', porCat.falhou + porCat.ausente > 0)}${stat(porCat.aguardando, 'Grupos aguardando o CI do commit final', porCat.aguardando > 0)}${stat(resumoCI, 'Testes no CI do commit final', !ci)}${stat(resumoLocal, 'Reprodução local (informativa)', false)}${stat(cap.passos.length, 'Passos HTTP/serviço no banco descartável', false)}${stat(cap.consultas.length, 'Consultas SQL no banco descartável', false)}${stat(matriz.length, 'Linhas do caderno na matriz', false)}</div>`);

  // ---- 1 estado
  parts.push(`<section id="estado"><h2>1. Estado desta execução</h2><p class="lead">${bannerCI}</p><div class="tw"><table><thead><tr><th>Categoria</th><th>Grupos</th><th>Linhas da matriz do caderno</th></tr></thead><tbody>${PRIOR_KEYS.map((k) => `<tr><td>${R.badge(k)}</td><td class="r">${porCat[k]}</td><td class="r">${matrizPorCat[k]}</td></tr>`).join('')}<tr class="tot"><td>Total</td><td class="r">39</td><td class="r">${matriz.length}</td></tr></tbody></table></div>
<p class="small">Rodadas anteriores de auditoria e correção, na ordem em que aconteceram:</p><ol class="tl">${base.rodadas.map((r) => `<li class="${R.esc(r.classe)}"><div class="when">${R.txt(r.data)} — ${R.txt(r.titulo)}</div><p><b>Achado:</b> ${R.txt(r.achado)}</p><p><b>Causa:</b> ${R.txt(r.causa)}</p><p><b>Correção:</b> ${R.txt(r.correcao)}</p><p><b>Reconfirmação:</b> ${R.txt(r.reconfirmacao)}</p></li>`).join('')}</ol></section>`);

  // ---- 2 reprodução
  const shaCommit = ciInfo ? ciInfo.sha : (apiCommit !== 'não informado' ? apiCommit : '<HASH-DO-COMMIT>');
  parts.push(`<section id="reproducao"><h2>2. Como reproduzir exatamente esta execução</h2>
<p class="lead">Mesmo procedimento do job <code>test</code> de <code>.github/workflows/test.yml</code>. O script <code>scripts/reproduzir-conferencia.sh</code> foi ajustado ao workflow; o comando de teste do CI não foi alterado.</p>
<h3 class="msec">Passo a passo</h3>
${R.pre(`# 1. obter exatamente o commit avaliado
git clone https://github.com/${REPO_API}.git && cd NayaraOne--API
git checkout ${shaCommit}

# 2. pré-requisitos: Node 20 (versão do CI), Docker OU PostgreSQL 16 com initdb, git
node -v          # v20.x
npm ci

# 3. executar (lint, syntax-check, scanners, migrations do zero, seeds, role sem bypass de RLS, suíte inteira)
REPRO_CAPTURA=1 bash scripts/reproduzir-conferencia.sh ./test-results.log
#   gera ./test-results.log (original), ./test-results.saneado.log e ./test-results.captura.json

# comando de teste idêntico ao do CI (dentro do script):
node --test --test-reporter=spec --test-reporter-destination=stdout test/*.test.js

# 4. logs e artifacts do CI (precisa de login no GitHub)
gh run download <RUN_ID> -R ${REPO_API}      # artifact test-results-<commit>

# 5. reexecutar no próprio GitHub, sem deploy: Actions > CI > Run workflow (workflow_dispatch)`, 'cmd-reproducao')}
<h3 class="msec">Ambiente do CI e do script (idênticos)</h3>
<ul class="sec">${base.reproducao.workflow.map((w) => `<li>${R.esc(w)}</li>`).join('')}</ul>
<h3 class="msec">Usuários fictícios do seed de dois tenants</h3>
<div class="tw"><table><thead><tr><th>Perfil</th><th>Permissões</th><th>Papel</th></tr></thead><tbody>${[['maker', 'cria e solicita'], ['checker', 'aprova; também cria, para provar que quem cria não aprova é regra de negócio'], ['leitura', 'só lê'], ['gestor', 'perfil operacional completo de Financeiro, Jurídico e Cobrança (sem contornar MFA); usado só na captura HTTP']].map(([p, papel]) => { const u = (cap.usuarios.find((x) => x.perfil === p && x.tenant === 'A') || {}); return `<tr><td>${R.esc(p)}</td><td>${R.esc((u.permissoes || []).join(', ') || 'ver scripts/seed-ci-two-tenants.js')}</td><td>${R.esc(papel)}</td></tr>`; }).join('')}</tbody></table></div>
<p class="small">${R.esc(base.reproducao.seeds.nota)} A credencial desses usuários só existe dentro do banco descartável.</p>
<h3 class="msec">Hashes</h3>
<div class="tw"><table><thead><tr><th>Arquivo</th><th>Nome</th><th>SHA-256 do arquivo publicado</th><th>SHA-256 do original</th></tr></thead><tbody>${hashLinhas.map((h) => `<tr><td>${R.esc(h[0])}</td><td><code>${R.esc(h[1])}</code></td><td><code>${R.esc(h[2])}</code></td><td><code>${R.esc(h[3])}</code></td></tr>`).join('') || '<tr><td colspan="4">Os hashes dos logs aparecem quando o gerador lê os logs do CI e da reprodução local.</td></tr>'}</tbody></table></div>
<h3 class="msec">Sanitização (tudo o que é truncado, traduzido ou removido)</h3><ul class="sec">${sanitizacao.map((s) => `<li>${R.esc(s)}</li>`).join('')}</ul></section>`);

  // ---- 3 grupos
  parts.push(`<section id="grupos"><h2>3. Os 39 grupos da conferência → testes → resultado individual</h2><p class="lead">Categoria do grupo = a pior categoria entre seus testes. ${R.esc(ci ? 'Resultado lido do log do CI.' : 'Sem log de CI do commit final: todos aguardam.')} A coluna de reprodução local é informativa e não aprova nada.</p>`);
  for (const marco of ['Marco 4', 'Marco 5']) {
    const gs = grupos.filter((g) => g.marco === marco);
    parts.push(`<h3 class="msec">${marco} <span class="count">${gs.length} grupos</span></h3>`);
    parts.push(`<div class="tw"><table><thead><tr><th>Nº</th><th>Grupo</th><th>Categoria</th><th>Testes</th></tr></thead><tbody>${gs.map((g) => `<tr><td class="n">${g.n}</td><td><a href="#g${g.n}">${R.esc(g.grupo)}</a></td><td>${R.badge(g.cat)}</td><td class="r">${g.testes.length}</td></tr>`).join('')}</tbody></table></div>`);
  }
  for (const g of grupos) {
    const ps = passosDe(g.n); const cs = consultasDe(g.n);
    const prs = prints ? prints.itens.filter((p) => p.chave === String(g.n) && !p.duplicadoDe) : [];
    parts.push(`<div class="fbox" id="g${g.n}"><h3>${g.n}. ${R.esc(g.grupo)} · ${R.esc(g.marco)} ${R.badge(g.cat)}</h3><p class="small"><b>Cenário:</b> ${R.txt(g.cenario)}</p>
<h4>Testes e resultado individual</h4>${R.tabelaTestes(g.testes, ci, local)}
<h4>Evidência específica: HTTP real no banco descartável</h4>${R.tabelaPassos(ps)}
${cs.length ? `<h4>Consultas somente leitura no banco descartável</h4>${R.tabelaConsultas(cs)}` : ''}
<p class="small"><b>Capturas de homologação de 19/10 ligadas a este grupo:</b> ${homologDe(g.evidenciaHomologacao)}. <b>Linhas da matriz do caderno:</b> ${g.linhasMatriz}.</p>
${prs.length ? `<h4>Prints ao vivo (Claude Browser)</h4><p class="small">${prs.map((p) => `<a href="#print-${R.esc(p.arquivo)}">${R.esc(p.arquivo)}</a>`).join(', ')}</p>` : ''}</div>`);
  }
  parts.push('</section>');

  // ---- 4 F01..F06
  parts.push(`<section id="respostas"><h2>4. Pendências F01 a F06 do PDF: correção e evidência</h2><p class="lead">Para cada pendência: achado, causa, commits da correção, cada teste ligado ao seu resultado no log (com duração), o estado antes das correções (os mesmos testes executados contra o código do commit 46b0ecb) e a prova da regra no PostgreSQL descartável.</p>`);
  for (const f of base.respostasF) {
    const cls = f.testes.map((t) => ({ t, c: R.classificarTeste(ci, t.nome) }));
    const cat = R.pior(cls.map((x) => x.c.cat));
    const ps = cap.passos.filter((p) => (p.f || []).includes(f.id));
    const antesPass = antes ? f.testes.filter((t) => antes.get(t.nome) && antes.get(t.nome).status === 'pass').length : 0;
    const antesFail = antes ? f.testes.filter((t) => antes.get(t.nome) && antes.get(t.nome).status === 'fail').length : 0;
    const antesNao = f.testes.length - antesPass - antesFail;
    parts.push(`<div class="fbox" id="${R.esc(f.id)}"><h3>${R.esc(f.id)} — ${R.esc(f.titulo)} ${R.badge(cat)}</h3>
<dl class="kv"><dt>Achado</dt><dd>${R.txt(f.achado)}</dd><dt>Causa</dt><dd>${R.txt(f.causa)}</dd><dt>Correção</dt><dd>${f.correcao.map((c) => `<code>${R.esc(c.commit)}</code> ${R.esc(c.descricao)}`).join('<br>')}</dd>
<dt>Antes das correções</dt><dd>${antes ? `Dos ${f.testes.length} testes desta pendência, ${antesFail} falharam e ${antesPass} passaram contra o código do commit 46b0ecb${antesNao ? `; ${antesNao} não existiam ou não foram executados` : ''}.` : 'Execução do estado anterior indisponível nesta geração.'}</dd></dl>
<h4>Testes: resultado no CI do commit final, na reprodução local e antes</h4>${R.tabelaTestes(f.testes, ci, local, antes)}
<h4>Prova da regra no PostgreSQL descartável</h4>${ps.length ? R.tabelaPassos(ps) : '<p class="small">Esta pendência é provada pelos testes acima e pelo drill (seção 6); as chamadas HTTP que exigem MFA humano são recusadas sem MFA habilitado e a regra é provada por teste de serviço, sem chamar endpoint de MFA.</p>'}
<p class="small"><b>Capturas de homologação de 19/10:</b> ${homologDe(f.evidenciaHomologacao)}. ${f.aoVivoTexto ? R.esc(f.aoVivoTexto) : ''}</p></div>`);
  }
  parts.push('</section>');

  // ---- 5 matriz
  parts.push(`<section id="matriz"><h2>5. Matriz do caderno: ${matriz.length} linhas → implementação → testes → resultado</h2><p class="lead">Estado da linha = pior resultado entre seus testes. Cada linha tem o JSON próprio na seção 12 (âncora <code>#json-matriz-ID</code>).</p>`);
  for (const marco of ['Marco 4', 'Marco 5']) {
    const rs = matriz.filter((r) => r.marco === marco);
    parts.push(`<h3 class="msec">${marco} <span class="count">${rs.length} linhas</span></h3><div class="tw"><table class="mx"><thead><tr><th>ID</th><th>Requisito</th><th>Implementação</th><th>Testes e resultado</th><th>Estado</th></tr></thead><tbody>${rs.map((r) => `<tr><td class="n"><a href="#json-matriz-${R.esc(r.id)}">${R.esc(r.id)}</a><br><span class="small">${R.txt(r.secao)}</span></td><td>${R.txt(r.requisito)}</td><td><code>${R.txt(r.implementacao)}</code></td><td>${r.cls.map((x) => `<div class="small">${R.esc(x.t.nome)}<br>${R.celulaCI(x.c)}</div>`).join('') || 'sem teste ligado'}</td><td>${R.badge(r.cat)}</td></tr>`).join('')}</tbody></table></div>`);
  }
  parts.push('</section>');

  // ---- 6 logs
  const bloco = (titulo, nome, texto, id) => `<details id="${id}"><summary><b>${R.esc(titulo)}</b> <span class="small">(${texto.split('\n').length} linhas)</span></summary>${R.dl(texto, nome)}${R.pre(texto)}</details>`;
  parts.push(`<section id="logs"><h2>6. Logs completos (saneados)</h2><p class="lead">Texto integral, legível sem JavaScript. O SHA-256 do original e do saneado está na seção 2.</p>
${ciLog ? bloco(`CI do commit final — ${ciLog.nome}`, ciLog.nome, ciLog.texto, 'log-ci') : '<p>O log do CI do commit final entra aqui quando o gerador é executado com o RUN_ID da API.</p>'}
${localLog ? bloco(`Reprodução local — ${localLog.nome}`, localLog.nome, localLog.texto, 'log-local') : ''}
${antesJson ? bloco('F01–F06 antes: testes do commit final contra o código do commit 46b0ecb', 'antes-46b0ecb-test-results.log', fs.readFileSync(path.join(ENT, 'antes-46b0ecb-test-results.log'), 'utf8'), 'log-antes') : ''}
${drill ? bloco('Drill de restore jurídico (133 checagens)', path.basename(drillFile), drill, 'log-drill') : ''}</section>`);

  // ---- 7 http
  parts.push(`<section id="http"><h2>7. Respostas HTTP reais no banco descartável (${cap.passos.length})</h2><p class="lead">${cap.meta ? `Captura de ${R.dataBR(cap.meta.quando)} no commit <code>${R.esc(String(cap.meta.commit).slice(0, 7))}</code>; ${R.esc(cap.meta.postgres.split(',')[0])}; role da suíte <code>${R.esc(cap.meta.roleDaSuite.rolname)}</code> (superusuário: ${cap.meta.roleDaSuite.rolsuper ? 'sim' : 'não'}; bypass de RLS: ${cap.meta.roleDaSuite.rolbypassrls ? 'sim' : 'não'}).` : 'Captura indisponível nesta geração.'} Passos "serviço" chamam a camada de serviço onde a rota exige MFA humano. Nenhum endpoint de MFA foi chamado.</p>${cap.passos.map((p) => R.blocoPasso(p)).join('')}${cap.passos.length ? R.dl(JSON.stringify(cap, null, 2), 'captura-descartavel.json', 'Baixar captura-descartavel.json', 'application/json') : ''}</section>`);

  // ---- 8 sql
  parts.push(`<section id="sql"><h2>8. Consultas somente leitura no banco descartável (${cap.consultas.length})</h2>${cap.consultas.map((c) => `<details id="sql-${R.esc(c.id)}"><summary><b>${R.esc(c.id)}</b> · ${R.esc(c.descricao)} <span class="b ${c.invarianteOk ? 'ok' : 'bad'}">${c.invarianteOk ? 'invariante confirmada' : 'invariante violada'}</span></summary>${R.pre({ sql: c.sql, resultado: c.resultado })}</details>`).join('')}</section>`);

  // ---- 9 homologação
  parts.push(`<section id="homologacao"><h2>9. Capturas de homologação de 19/10 (banco compartilhado de homologação, dados fictícios)</h2><p class="lead">Respostas HTTP (${base.httpHomologacao.length}) e consultas (${base.consultasBancoHomologacao.length}) colhidas na conferência de 19/10 contra o ambiente de homologação, com o usuário administrador. Nelas as ações que exigem MFA mostram a recusa; o caminho feliz com MFA foi feito por operador humano.</p>
<h3 class="msec">Respostas HTTP</h3>${base.httpHomologacao.map((h) => `<details id="hom-${R.esc(h.id)}"><summary><b>${R.esc(h.id)}</b> · ${R.esc(h.perfil)} · <code>${R.esc(h.metodo)} ${R.esc(h.rota)}</code> · ${R.esc(h.status)}${h.codigo ? ` ${R.esc(h.codigo)}` : ''}<br><span class="small">${R.txt(h.descricao)} — ${R.dataBR(h.dataHora)}</span></summary>${R.pre(h)}</details>`).join('')}
<h3 class="msec">Consultas ao banco de homologação</h3>${base.consultasBancoHomologacao.map((c) => `<details id="hom-${R.esc(c.id)}"><summary><b>${R.esc(c.id)}</b> · ${R.txt(c.descricao)} <span class="b ${c.invarianteOk ? 'ok' : 'bad'}">${c.invarianteOk ? 'invariante confirmada' : 'invariante violada'}</span></summary>${R.pre({ sql: c.sql, resultado: c.resultado })}</details>`).join('')}
<h3 class="msec">Trilha de auditoria com antes e depois (${base.auditoria.length} registros)</h3><div class="tw"><table class="tt"><thead><tr><th>Quando</th><th>Ação</th><th>Entidade</th><th>Antes</th><th>Depois</th><th>Motivo</th></tr></thead><tbody>${base.auditoria.map((a) => `<tr><td>${R.esc(a.dataHoraBR)}</td><td>${R.txt(a.rotulo)}</td><td>${R.txt(a.entidade)}</td><td>${R.pre(a.antes)}</td><td>${R.pre(a.depois)}</td><td>${R.txt(a.motivo)}</td></tr>`).join('')}</tbody></table></div>
<h3 class="msec">Segurança</h3><ul class="sec">${base.seguranca.itens.map((i) => `<li>${i}</li>`).join('')}</ul></section>`);

  // ---- 10 prints
  if (prints) {
    const unicos = prints.itens.filter((p) => !p.duplicadoDe);
    const dups = prints.itens.filter((p) => p.duplicadoDe);
    const falhas = prints.relatorio ? (prints.relatorio.match(/FALHA/g) || []).length : 0;
    parts.push(`<section id="prints"><h2>10. Prints ao vivo (Claude Browser)</h2><p class="lead">${prints.itens.length} arquivos na pasta, ${unicos.length} únicos${dups.length ? `; repetidos (mesmo conteúdo, SHA-256 igual): ${dups.map((d) => `${R.esc(d.arquivo)} = ${R.esc(d.duplicadoDe)}`).join('; ')}` : ''}. ${prints.relatorio ? `O relatório do operador tem ${falhas} ocorrência(s) da palavra FALHA.` : 'A pasta não tem relatorio.md.'}</p>
${prints.relatorio ? `<details id="relatorio-prints"><summary><b>Relatório do Claude Browser</b></summary>${R.dl(prints.relatorio, 'relatorio.md')}${R.pre(prints.relatorio)}</details>` : ''}
<div class="figs">${unicos.map((p) => `<figure id="print-${R.esc(p.arquivo)}"><img alt="${R.esc(p.arquivo)}" src="data:image/jpeg;base64,${p.b64}"><figcaption><b>${R.esc(p.arquivo)}</b><br>${p.chave ? `Grupo/pendência ${R.esc(p.chave)}` : 'sem número no nome do arquivo'} · ${p.bytes.toLocaleString('pt-BR')} bytes<br><span class="small">SHA-256 <code>${R.esc(p.sha)}</code></span></figcaption></figure>`).join('')}</div></section>`);
  }

  // ---- 11 reconf
  const rec = base.reconferenciaAoVivo;
  parts.push(`<section id="reconf"><h2>11. Reconferência ao vivo de 19/10 pelo navegador (texto)</h2><p class="lead">Janela: ${R.txt(rec.janela.data)} em ${R.txt(rec.janela.ambiente)}. ${R.txt(rec.janela.mfa)} Os prints dessa reconferência não estão nesta página.</p>
<h3 class="msec">Falhas encontradas e corrigidas</h3><div class="tw"><table class="tt"><thead><tr><th>Id</th><th>Passo</th><th>Falha</th><th>Causa</th><th>Correção</th><th>Commits</th><th>Reconfirmação</th></tr></thead><tbody>${rec.falhas.map((f) => `<tr><td>${R.txt(f.id)}</td><td>${R.txt(f.passo)}</td><td>${R.txt(f.falha)}</td><td>${R.txt(f.causa)}</td><td>${R.txt(f.correcao)}</td><td>${R.txt((f.commits || []).join(', '))}</td><td>${R.txt(f.reconfirmacao)}</td></tr>`).join('')}</tbody></table></div>
<h3 class="msec">Bloqueio e como foi tratado</h3><p>${R.txt(rec.bloqueio.passo)}: ${R.txt(rec.bloqueio.motivo)} ${R.txt(rec.bloqueio.correcao)} ${R.txt(rec.bloqueio.reconfirmacao)}</p>
<h3 class="msec">Passos</h3><div class="tw"><table class="tt"><thead><tr><th>Passo</th><th>Hora</th><th>Usuário</th><th>Ação</th><th>Esperado</th><th>Obtido</th><th>Situação</th></tr></thead><tbody>${rec.passos.map((p) => `<tr><td>${R.txt(p.passo)}</td><td>${R.txt(p.hora)}</td><td>${R.txt(p.usuario)}</td><td>${R.txt(p.acao)}</td><td>${R.txt(p.esperado)}</td><td>${R.txt(p.obtido)}</td><td>${R.txt(p.status)}</td></tr>`).join('')}</tbody></table></div>
<h3 class="msec">Observações</h3><ul class="sec">${rec.observacoes.map((o) => `<li><b>${R.esc(o[0])}</b> ${R.esc(o[1])} <i>${R.esc(o[2])}</i></li>`).join('')}</ul></section>`);

  // ---- 12 anexo json
  const anexo = { meta: { gerador: 'scripts/gerar-entrega-marco45.js', geradoEm: agora.toISOString(), apiCommit, frontCommit, ci: ciInfo, front: frontInfo, hashes: hashLinhas.map((h) => ({ nome: h[1], shaPublicado: h[2], shaOriginal: h[3] })), sanitizacao }, grupos: grupos.map((g) => ({ n: g.n, marco: g.marco, grupo: g.grupo, categoria: CATNOME(g.cat), testes: g.cls.map((x) => ({ arquivo: x.t.arquivo, nome: x.t.nome, categoria: CATNOME(x.c.cat), resultadoCi: x.c.r })) })) };
  function CATNOME(c) { return R.CAT[c][0]; }
  parts.push(`<section id="anexo-json"><h2>12. Anexo JSON</h2><p class="lead">Texto legível, sem JavaScript. O botão baixa o arquivo.</p>
<details open><summary><b>Resultado por grupo e metas</b></summary>${R.dl(JSON.stringify(anexo, null, 2), 'evidencias-marco4-5.json', 'Baixar evidencias-marco4-5.json', 'application/json')}${R.pre(anexo, 'json-pre')}</details>
<h3 class="msec">Uma linha da matriz por bloco</h3>${matriz.map((r) => `<details><summary>${R.esc(r.id)} · ${R.esc(r.secao)} · ${R.esc(R.CAT[r.cat][0])}</summary>${R.pre({ ...r, cls: undefined, cat: undefined, categoria: R.CAT[r.cat][0], testes: r.cls.map((x) => ({ arquivo: x.t.arquivo, nome: x.t.nome, categoria: R.CAT[x.c.cat][0], resultadoCi: x.c.r })) }, `json-matriz-${r.id}`)}</details>`).join('')}</section>`);

  // ---- 13/14
  parts.push(`<section id="conferir"><h2>13. Como conferir</h2><ol class="steps"><li>Confira o commit e o run no cabeçalho; baixe o artifact do run (<code>gh run download</code>) e compare o SHA-256 do original com a seção 2.</li><li>Rode <code>scripts/reproduzir-conferencia.sh</code> (seção 2) e compare a lista de testes aprovados com a do CI.</li><li>Procure um teste pelo nome exato nas tabelas dos grupos e no log (seção 6).</li><li>Para qualquer chamada HTTP, abra o bloco da seção 7 e leia o corpo bruto da resposta.</li><li>Para as regras sem rota sem MFA, leia o passo de serviço e o teste citado.</li></ol></section>
<section id="fora"><h2>14. Limites desta execução</h2><ul class="sec"><li>Banco, assinatura eletrônica e provedores externos rodam em modo simulado (sandbox): nenhum dinheiro real e nenhum envio jurídico real.</li><li>Ações com MFA humano não são exercitadas por HTTP nesta execução; aparecem como recusa (MFA não habilitado nos usuários fictícios) e a regra é provada por teste de serviço.</li><li>As conferências visuais de tela são feitas pelo Claude Browser com operador humano (pasta de prints); sem a pasta de prints, a página mostra a evidência HTTP e SQL e não tem a seção de prints.</li><li>Esta página não declara aceite: ela mostra o que o log do commit indicado prova.</li></ul></section>
<footer class="sign">Gerada por scripts/gerar-entrega-marco45.js em ${R.dataBR(agora)}.</footer></div></body></html>`);
  return { html: parts.join('\n'), porCat, apiCommit, ciInfo };
}

const { html, porCat, apiCommit } = montar();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`[gerar-entrega-marco45] ${OUT} (${(html.length / 1048576).toFixed(2)} MB) commit ${apiCommit}; grupos: ${JSON.stringify(porCat)}`);
