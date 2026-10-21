'use strict';
/**
 * Renderização da página de entrega dos Marcos 4 e 5. Funções puras: recebem os dados já lidos
 * (base.json, logs parseados, captura, prints) e devolvem HTML. Sem JavaScript na página:
 * JSON e logs ficam em <pre>/<details> e o download é um <a download> com data URI.
 */
const fs = require('node:fs');
const path = require('node:path');
const { resultadoDe } = require('./parseLog');

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vazio = (v) => (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '—');
const txt = (v, alt = 'não informado') => (vazio(v) ? alt : esc(v));

function dataBR(iso, comHora = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'data indisponível';
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d)
    .reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return comHora ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}` : `${p.day}/${p.month}/${p.year}`;
}
const ms = (n) => (n === null || n === undefined ? 'sem duração' : `${Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ms`);

const CAT = {
  aprovado: ['aprovado', 'ok'],
  falhou: ['falhou', 'bad'],
  ausente: ['ausente do log do CI', 'bad'],
  naoimpl: ['não implementado', 'warn'],
  bloqueado: ['bloqueado por ambiente', 'warn'],
  aguardando: ['aguardando CI do commit final', 'warn'],
};
const badge = (cat) => `<span class="b ${CAT[cat][1]}">${CAT[cat][0]}</span>`;

/** Classifica um teste pelo log do CI (ci = parseLog ou null). */
function classificarTeste(ci, nome) {
  if (!ci) return { cat: 'aguardando', r: null };
  const r = resultadoDe(ci, nome);
  if (!r) return { cat: 'ausente', r: null };
  const cat = r.status === 'pass' ? 'aprovado' : r.status === 'fail' ? 'falhou' : r.status === 'todo' ? 'naoimpl' : 'bloqueado';
  return { cat, r };
}
const PRIOR = ['falhou', 'ausente', 'naoimpl', 'bloqueado', 'aguardando', 'aprovado'];
function pior(cats) {
  if (!cats.length) return 'aguardando';
  return PRIOR.find((c) => cats.includes(c));
}

function localTxt(local, nome) {
  if (!local) return 'sem reprodução local';
  const r = resultadoDe(local, nome);
  if (!r) return 'ausente da reprodução local';
  return `${{ pass: 'passou', fail: 'falhou', skip: 'pulado', todo: 'não implementado' }[r.status]}, ${ms(r.duracaoMs)}`;
}

function celulaCI(c) {
  if (!c.r) return `${badge(c.cat)}`;
  return `${badge(c.cat)} <span class="small">${ms(c.r.duracaoMs)}${c.r.ocorrencias > 1 ? `; nome repetido ${c.r.ocorrencias} vezes no log` : ''}</span>`;
}

function pre(obj, id) {
  const texto = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return `<pre class="json"${id ? ` id="${esc(id)}"` : ''}>${esc(texto)}</pre>`;
}
function dataUri(texto, mime) {
  return `data:${mime};charset=utf-8;base64,${Buffer.from(texto, 'utf8').toString('base64')}`;
}
const dl = (texto, nome, rotulo, mime = 'text/plain') => `<a class="dl" download="${esc(nome)}" href="${dataUri(texto, mime)}">${esc(rotulo || `Baixar ${nome}`)}</a>`;

function tabelaTestes(testes, ci, local, antes, rotulos = {}) {
  const h1 = rotulos.principal || 'Resultado no log do CI';
  const h2 = rotulos.local || 'Reprodução local';
  const linhas = testes.map((t) => {
    const c = classificarTeste(ci, t.nome);
    const a = antes ? antes.get(t.nome) : null;
    return `<tr><td><code>${esc(t.arquivo)}</code></td><td>${esc(t.nome)}</td><td>${celulaCI(c)}</td><td class="small">${esc(localTxt(local, t.nome))}</td>${antes ? `<td class="small">${a ? `${a.status === 'pass' ? 'passou' : 'falhou'}, ${ms(a.duracaoMs)}` : 'não executado'}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="tw"><table class="tt"><thead><tr><th>Arquivo</th><th>Teste (nome exato)</th><th>${esc(h1)}</th><th>${esc(h2)}</th>${antes ? '<th>Antes (commit 46b0ecb)</th>' : ''}</tr></thead><tbody>${linhas}</tbody></table></div>`;
}

function passoResumo(p) {
  const exp = `${p.esperado.status !== undefined ? p.esperado.status : (p.esperado.erro || 'ok')}${p.esperado.codigo ? ` ${p.esperado.codigo}` : ''}`;
  const obt = `${p.status}${p.codigo ? ` ${p.codigo}` : ''}`;
  return { exp, obt };
}
function blocoPasso(p, prefixo = 'http') {
  const { exp, obt } = passoResumo(p);
  const conteudo = { id: p.id, perfil: p.perfil, metodo: p.metodo, rota: p.rota, corpoEnviado: p.corpoEnviado, esperado: p.esperado, status: p.status, codigo: p.codigo, corpoResposta: p.corpo, duracaoMs: p.ms, quando: p.quando };
  return `<details id="${prefixo}-${esc(p.id)}"><summary><b>${esc(p.id)}</b> · ${esc(p.perfil)} · <code>${esc(p.metodo)} ${esc(p.rota)}</code> · esperado ${esc(exp)}, obtido ${esc(obt)} <span class="b ${p.ok ? 'ok' : 'bad'}">${p.ok ? 'conforme o esperado' : 'divergente'}</span><br><span class="small">${esc(p.titulo)}</span></summary>${pre(conteudo)}</details>`;
}
function tabelaPassos(passos) {
  if (!passos.length) return '<p class="small">Nenhum passo HTTP desta captura aponta para este item; a prova está nos testes e nas consultas listadas.</p>';
  const linhas = passos.map((p) => {
    const { exp, obt } = passoResumo(p);
    return `<tr><td><a href="#http-${esc(p.id)}">${esc(p.id)}</a></td><td>${esc(p.titulo)}</td><td>${esc(p.perfil)}</td><td><code>${esc(p.metodo)} ${esc(p.rota)}</code></td><td>${esc(exp)}</td><td>${esc(obt)}</td><td><span class="b ${p.ok ? 'ok' : 'bad'}">${p.ok ? 'conforme' : 'divergente'}</span></td></tr>`;
  }).join('');
  return `<div class="tw"><table class="tt"><thead><tr><th>Passo</th><th>O que prova</th><th>Perfil</th><th>Chamada</th><th>Esperado</th><th>Obtido</th><th>Situação</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}
function tabelaConsultas(consultas) {
  if (!consultas.length) return '';
  const linhas = consultas.map((c) => `<tr><td><a href="#sql-${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.descricao)}</td><td><span class="b ${c.invarianteOk ? 'ok' : 'bad'}">${c.invarianteOk ? 'invariante confirmada' : 'invariante violada'}</span></td></tr>`).join('');
  return `<div class="tw"><table class="tt"><thead><tr><th>Consulta</th><th>O que verifica (somente leitura)</th><th>Resultado</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}

module.exports = { esc, vazio, txt, dataBR, ms, badge, CAT, classificarTeste, pior, localTxt, celulaCI, pre, dl, dataUri, tabelaTestes, tabelaPassos, tabelaConsultas, blocoPasso, passoResumo,
  estilo: () => fs.readFileSync(path.join(__dirname, 'estilo.css'), 'utf8') };
