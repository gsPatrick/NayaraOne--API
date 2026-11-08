'use strict';
/** Registro das conferências e do quadro final. Nada de segredo é impresso: só ids, status HTTP e trechos curtos. */
class Relato {
  constructor() { this.conferencias = []; this.quadro = []; this.avisos = []; this.ids = {}; }

  /** Uma conferência: ok=true passa, false falha, null = não verificado (com motivo). */
  conferir(cenario, descricao, ok, evidencia) {
    this.conferencias.push({ cenario, descricao, ok, evidencia: evidencia || '' });
    const marca = ok === true ? 'OK    ' : ok === false ? 'FALHOU' : 'N/VERIF';
    console.log(`  [${marca}] ${descricao}${evidencia ? `\n           -> ${evidencia}` : ''}`);
  }

  item(tipo, nome, situacao, id, ondeVer) { this.quadro.push({ tipo, nome, situacao, id: id || '-', ondeVer: ondeVer || '' }); }
  aviso(texto) { this.avisos.push(texto); console.log(`  [AVISO ] ${texto}`); }

  imprimirQuadro() {
    console.log('\n===== QUADRO: o que foi criado ou encontrado =====');
    for (const q of this.quadro) console.log(`- ${q.tipo} | ${q.nome} | ${q.situacao} | id ${q.id}${q.ondeVer ? ` | ver em: ${q.ondeVer}` : ''}`);
    console.log('\n===== RESULTADO DAS CONFERÊNCIAS =====');
    const por = {};
    for (const c of this.conferencias) {
      por[c.cenario] = por[c.cenario] || { ok: 0, falhou: 0, nv: 0 };
      if (c.ok === true) por[c.cenario].ok += 1; else if (c.ok === false) por[c.cenario].falhou += 1; else por[c.cenario].nv += 1;
    }
    for (const [cen, n] of Object.entries(por)) console.log(`- ${cen}: ${n.ok} ok, ${n.falhou} falharam, ${n.nv} não verificadas`);
    if (this.avisos.length) { console.log('\nAvisos:'); this.avisos.forEach((a) => console.log(`- ${a}`)); }
  }

  get falhas() { return this.conferencias.filter((c) => c.ok === false).length; }
}

module.exports = { Relato };
