#!/usr/bin/env node
'use strict';
/**
 * Check endurecido da página de entrega dos Marcos 4/5.
 *   node scripts/checar-entrega-marco45.js <marco4-5.html>
 * Falha (exit 1) com qualquer erro. Verifica: segredos no conteúdo DECODIFICADO (data URIs e
 * imagens), nenhum <script>, âncoras internas resolvem, texto visível sem célula vazia, "—"
 * sozinho, null/undefined, data ISO, e-mail real, frases proibidas, um único marcador CI_FINAL.
 */
const fs = require('node:fs');

const arq = process.argv[2];
if (!arq) { console.error('uso: checar-entrega-marco45.js <arquivo.html>'); process.exit(2); }
const html = fs.readFileSync(arq, 'utf8');
const erros = [];
const avisos = [];

// ---- 1. segredos no conteúdo decodificado
const ESTRITO = /DevAdmin|DevAprovador|2\.25\.115|postgres:\/\/|Bearer ey|eyJ/;
const PALAVRAS = /senha|password|TOTP/gi;
const corpos = [{ origem: 'html', texto: html.replace(/data:[^"']+;base64,[A-Za-z0-9+/=]+/g, '') }];
for (const m of html.matchAll(/data:([^;"',]+)(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)/g)) {
  const buf = Buffer.from(m[2], 'base64');
  corpos.push({ origem: `data-uri ${m[1]} (${buf.length} bytes)`, texto: buf.toString(m[1].startsWith('image/') ? 'latin1' : 'utf8') });
}
const palavrasAchadas = [];
for (const c of corpos) {
  const e = ESTRITO.exec(c.texto);
  if (e) erros.push(`segredo (${e[0]}) em ${c.origem}`);
  if (!c.origem.includes('image/')) for (const m of c.texto.matchAll(PALAVRAS)) palavrasAchadas.push(`${c.origem}: …${c.texto.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, ' ')}…`);
}

// ---- 2. estrutura
if (/<script[\s>]/i.test(html)) erros.push('a página contém <script>');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const quebradas = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((h) => !ids.has(h)))];
if (quebradas.length) erros.push(`âncoras sem destino (${quebradas.length}): ${quebradas.slice(0, 10).join(', ')}`);

// ---- 3. texto visível
const visivel = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<pre[\s\S]*?<\/pre>/g, '<pre>bloco</pre>').replace(/<textarea[\s\S]*?<\/textarea>/g, '');
const celulas = [...visivel.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
const vazias = celulas.filter((c) => c === '' || c === '—' || c === '-' || /^(null|undefined|n\/a)$/i.test(c)).length;
if (vazias) erros.push(`${vazias} célula(s) vazia(s), "—", null ou undefined`);
const texto = visivel.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const iso = texto.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g);
if (iso) erros.push(`data ISO visível (${iso.length}): ${iso.slice(0, 3).join(', ')}`);
if (/\bnull\b|\bundefined\b|\[object Object\]/.test(texto)) erros.push('"null", "undefined" ou [object Object] no texto visível');
const emails = [...new Set((texto.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).filter((e) => !/@(exemplo\.test|exemplo\.invalid|ci\.nayaraone\.test)$/.test(e)))];
if (emails.length) erros.push(`e-mail não fictício no texto visível: ${emails.join(', ')}`);
for (const frase of [/pronto para aceite/i, /próxima rodada/i, /ainda não testado/i, /Easypanel/i, /Pendente de teste/i]) if (frase.test(texto)) erros.push(`frase proibida no texto visível: ${frase}`);
const cf = (html.match(/CI_FINAL/g) || []).length;
if (cf > 1) erros.push(`marcador CI_FINAL aparece ${cf} vezes (deve ser no máximo 1)`);

// ---- 4. blocos esperados
for (const id of ['estado', 'reproducao', 'grupos', 'respostas', 'matriz', 'logs', 'http', 'sql', 'anexo-json']) if (!ids.has(id)) erros.push(`seção ausente: #${id}`);
for (let n = 1; n <= 39; n += 1) if (!ids.has(`g${n}`)) erros.push(`grupo ${n} ausente`);
for (const f of ['F01', 'F02', 'F03', 'F04', 'F05', 'F06']) if (!ids.has(f)) erros.push(`${f} ausente`);
const jsonMatriz = [...ids].filter((i) => i.startsWith('json-matriz-')).length;

console.log(`[checar] ${arq}: ${(html.length / 1048576).toFixed(2)} MB; ${celulas.length} células; ${jsonMatriz} blocos json-matriz; marcador CI_FINAL: ${cf}`);
console.log(`[checar] segredos estritos no conteúdo decodificado (DevAdmin|DevAprovador|2.25.115|postgres://|Bearer ey|eyJ): ${erros.some((e) => e.startsWith('segredo')) ? 'ENCONTRADO' : '0'}`);
console.log(`[checar] ocorrências das palavras senha|password|TOTP no conteúdo decodificado: ${palavrasAchadas.length}`);
for (const p of palavrasAchadas.slice(0, 30)) console.log(`   ${p}`);
for (const a of avisos) console.log(`[aviso] ${a}`);
if (erros.length) { for (const e of erros) console.error(`[ERRO] ${e}`); console.error(`[checar] ${erros.length} erro(s)`); process.exit(1); }
console.log('[checar] 0 erros');
