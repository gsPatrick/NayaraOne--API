'use strict';

/**
 * M9-D706/M9-D707 — leitura somente leitura dos arquivos de demanda do Marco 9 (`<demandas>/marco-9/M9-D*.md`): id, título, status e
 * dependências do cabeçalho. A pasta vem de `--demandas`, de `ANALYTICS_DEMANDAS_DIR` ou, por padrão, de `Maturacao/demandas` ao lado da API.
 */
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..', '..', '..');
const RE_ID = /\bM9-D\d{3}\b/g;
const BLOCO_BI = /^M9-D[67]\d{2}$/;

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function pastaPadrao(env = process.env) {
  return env.ANALYTICS_DEMANDAS_DIR || path.join(API_ROOT, '..', 'Maturacao', 'demandas');
}

function lerDemanda(texto, arquivo) {
  const h1 = texto.split('\n').find((l) => /^#\s/.test(l)) || '';
  const m = h1.match(/^#\s+(M9-D\d{3})\s+[—–-]\s+(.*)$/);
  const campo = (nome) => {
    const re = new RegExp(`^\\|\\s*${nome}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'mi');
    const linha = texto.match(re);
    return linha ? linha[1] : '';
  };
  const dependencias = Array.from(new Set(semAcento(campo('Dependências')).match(RE_ID) || []));
  const status = semAcento(campo('Status')).toLowerCase().replace(/\s+/g, '');
  return { id: m ? m[1] : '', titulo: m ? m[2].trim() : '', status, dependencias, texto, arquivo };
}

/** Mapa id -> demanda de `<pasta>/marco-9`. Lança erro claro se a pasta não existe. */
function carregarDemandas(pasta) {
  const dir = path.join(pasta, 'marco-9');
  if (!fs.existsSync(dir)) throw new Error(`pasta de demandas não encontrada: ${dir} (use --demandas ou ANALYTICS_DEMANDAS_DIR)`);
  const mapa = new Map();
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const d = lerDemanda(fs.readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f));
    if (d.id) mapa.set(d.id, d);
  }
  return mapa;
}

module.exports = { carregarDemandas, lerDemanda, pastaPadrao, BLOCO_BI, API_ROOT };
