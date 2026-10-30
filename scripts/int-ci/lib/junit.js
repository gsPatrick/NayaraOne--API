'use strict';

/** Leitura do JUnit do node:test (M9-D258): os casos de teste com arquivo, nome e estado (pass, fail ou skip). */
const entidades = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const desfazer = (s) => String(s).replace(/&(?:quot|apos|lt|gt|amp);/g, (m) => entidades[m]);
const atributo = (attrs, nome) => { const m = new RegExp(`\\b${nome}="([^"]*)"`).exec(attrs); return m ? desfazer(m[1]) : ''; };

function casosDoJunit(xml) {
  const casos = [];
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const corpo = m[2] || '';
    casos.push({ arquivo: atributo(m[1], 'file'), nome: atributo(m[1], 'name'), status: /<(?:failure|error)\b/.test(corpo) ? 'fail' : /<skipped\b/.test(corpo) ? 'skip' : 'pass' });
  }
  return casos;
}

module.exports = { casosDoJunit };
