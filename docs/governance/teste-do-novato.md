# Teste do novato (M9-D891)

Quem verifica a M9-D891 parte SÓ dos READMEs de `src/features/core-governance/*/README.md` e dos runbooks de `docs/runbooks/governance/`, sobe o módulo em banco descartável (`node scripts/withDisposableDb.js --port <porta> -- ...`, nunca o banco do `.env`) e executa uma operação de cada módulo, sem pedir ajuda a quem escreveu. Cada linha abaixo traz o responsável de quem executou: seis linhas são do VERIFICADOR INDEPENDENTE (registro da verificação de 30/10/2026); as de lineage e bcp, que a verificação não completou, foram executadas na correção da reabertura e ficam para o verificador reconfirmar. O teste `m9d891 teste do novato executado e registrado` confere que nenhuma linha ficou em branco com a operação executada, a data (AAAA-MM-DD), o responsável e o resultado.

| Módulo | Operação executada (runbook) | Data | Responsável | Resultado |
|---|---|---|---|---|
| calendar | backfill da projeção rodado 2 vezes (`calendario.md`), partindo só do runbook | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0, `errors: 0`; segunda rodada não duplicou |
| data-quality | varredura de qualidade e mesclagem (`dados-mestres.md`) | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0; fila e mesclagem executadas |
| lineage | conferir a cobertura e o registro (`lineage.md`): `npm run check:lineage` e `npm run sync:lineage -- --check` em banco descartável | 2026-10-30 | GOV-D890-D891-D809 (correção da reabertura) | `covered=45/45 percent=100 uncovered=[]`; "Registro de lineage igual às sementes"; exit 0 (a reconfirmar pelo verificador na 3ª verificação) |
| dlp | job de expiração de exportações (`dlp.md`) | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0 (o passo de teste citava `node` sobre .sh e falhava; corrigido para `bash`) |
| bcp | passo de teste do módulo (`bcp.md`): `bash scripts/ci-governanca.sh bcp` em banco descartável | 2026-10-30 | GOV-D890-D891-D809 (correção da reabertura) | 90 testes, nenhum pulado, exit 0, incluindo `m9d832 BCP record importado 2x não duplica` (a reconfirmar pelo verificador na 3ª verificação) |
| api-governance | job de aviso de depreciação (`api-governance.md`) | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0 (o comando do teste citava `node` sobre .sh; corrigido para `bash`) |
| finops | coleta do coletor de custos (`finops.md`) | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0; coleta executada (o passo de teste foi corrigido para `bash`) |
| feature-flags | job de expiração e simulacro do kill switch (`flags.md`) | 2026-10-30 | GOV-VERIF-D890-D891-D809 (verificador independente) | exit 0 nas duas operações (o comando do teste foi corrigido para `bash`) |
