'use strict';

// Descobre, de forma síncrona, uma porta TCP efêmera livre em 127.0.0.1 (o SO escolhe com listen(0)).
// Serve a testes que precisam definir process.env.PORT antes de requerer o app, sem porta fixa que colida com outros processos.
const { execFileSync } = require('node:child_process');

const SONDA = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";

function portaLivre() {
  const saida = execFileSync(process.execPath, ['-e', SONDA], { encoding: 'utf8' }).trim();
  const porta = Number(saida);
  if (!Number.isInteger(porta) || porta <= 0) throw new Error('Não foi possível obter uma porta livre.');
  return String(porta);
}

module.exports = { portaLivre };
