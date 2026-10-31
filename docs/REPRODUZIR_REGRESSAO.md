# Reproduzir a regressão completa da API

Este guia permite a um terceiro (por exemplo, a auditoria da cliente) rodar **todos os testes da API** em um banco PostgreSQL **descartável**, sem tocar em nenhum banco real. A falta de PostgreSQL na máquina de execução é uma limitação do ambiente, não um defeito do sistema: abaixo está como supri-la.

## 1. Versões necessárias

| Item | Versão | Observação |
| --- | --- | --- |
| Node.js | 20 ou superior (o CI usa 20; a rodada de evidência usou 24) | `node -v` |
| PostgreSQL | 16 ou 17 (o CI usa a imagem `postgres:16`) | precisa dos binários `initdb`, `pg_ctl`, `psql` |
| ClamAV (`clamd`) | 1.x, escutando em `127.0.0.1:3310` | os testes de upload usam o antivírus de verdade |
| Tesseract (com idioma `por`) e poppler (`pdftotext`) | qualquer versão recente | sem eles os testes de leitura de documentos ficam **pulados** |
| git, bash | qualquer | |

## 2. Instalar o PostgreSQL

O banco descartável é criado e apagado pelo próprio repositório (`scripts/withDisposableDb.js`): um cluster novo com `initdb` em diretório temporário, porta própria, migrations do zero, seeds e uma role de runtime `NOSUPERUSER NOBYPASSRLS` (o mesmo que o CI). **Não é preciso criar banco, usuário nem senha**, nem ter um servidor PostgreSQL já rodando; só os binários.

**Sem Docker**

- macOS (Homebrew): `brew install postgresql@16` (ou `@17`). Os binários são encontrados em `/opt/homebrew/opt/postgresql@NN/bin`.
- Debian/Ubuntu: `sudo apt-get install postgresql-16` (binários em `/usr/lib/postgresql/16/bin`, que **não** ficam no `PATH`; o script os encontra sozinho). Não é necessário iniciar o serviço do sistema.
- Outro caminho: `export DRILL_PG_BIN=/pasta/dos/binarios`.

**Com Docker**

- Para o PostgreSQL, use o script do CI, que detecta o Docker e sobe `postgres:16` sozinho: `bash scripts/reproduzir-conferencia.sh ./test-results.log` (ele também roda lint e scanners; ver `docs/evidencias/ci/README.md`).
- O fluxo por lotes (`regressao-descartavel.sh`) usa os binários do PostgreSQL da própria máquina; em um contêiner de trabalho Debian/Ubuntu (`node:20` com `apt-get install postgresql-16 tesseract-ocr tesseract-ocr-por poppler-utils`) eles ficam em `/usr/lib/postgresql/16/bin` e o `initdb` exige usuário não-root. Esse caminho em contêiner não foi exercitado na rodada de evidência (que usou binários locais); o caminho com Docker validado pelo CI é o `reproduzir-conferencia.sh`.

## 3. Subir o ClamAV

Os testes dos motores reais de upload conectam em `127.0.0.1:3310`. Sem ele a regressão **não começa** (o script falha com mensagem clara).

- Docker: `docker run -d --name clamav -p 127.0.0.1:3310:3310 clamav/clamav:stable`. A primeira subida baixa as assinaturas e leva alguns minutos; aguarde até a verificação abaixo responder.
- Debian/Ubuntu: `sudo apt-get install clamav-daemon` e, em `/etc/clamav/clamd.conf`, `TCPSocket 3310` e `TCPAddr 127.0.0.1`; depois `sudo freshclam && sudo systemctl restart clamav-daemon`.
- macOS: `brew install clamav`; crie `clamd.conf` e `freshclam.conf` a partir dos `.sample` em `/opt/homebrew/etc/clamav/` (comente a linha `Example`; em `clamd.conf` use `TCPSocket 3310` e `TCPAddr 127.0.0.1`), rode `freshclam` e `clamd`.
- Verificação: `printf 'PING\n' | nc -w2 127.0.0.1 3310` deve responder `PONG`.

Leitura de documentos: `brew install tesseract tesseract-lang poppler` (macOS) ou `sudo apt-get install tesseract-ocr tesseract-ocr-por poppler-utils libtiff-tools` (Debian/Ubuntu).

## 4. Preparar e rodar

```bash
git clone https://github.com/gsPatrick/NayaraOne--API.git && cd NayaraOne--API
git checkout 081fc440681c54599a865eb48a01da755c96ff32     # ou o commit a avaliar
npm ci
bash scripts/regressao-descartavel.sh ./regressao.log      # tudo, em 4 lotes
```

O script confere os pré-requisitos e **falha com código 2 e mensagem em português** se faltar Node, PostgreSQL, ClamAV ou Tesseract/poppler. Depois roda cada lote em seu próprio cluster descartável, soma os resultados e só termina com código 0 se houver **0 falhas, 0 canceladas e 0 pulados**.

Variáveis opcionais: `REGRESSAO_LOTES` (padrão 4), `REGRESSAO_PARALELO` (lotes simultâneos, padrão 1), `REGRESSAO_PORTA_BASE` (padrão aleatória em 55000-56900), `REGRESSAO_PADRAO` (lista de arquivos de teste), `DRILL_PG_BIN`, `CLAMAV_HOST`/`CLAMAV_PORT`.

O script não lê o `.env` da máquina: toda chave existente nele é neutralizada, e `DATABASE_URL`/chaves são geradas para o cluster descartável (`127.0.0.1`, banco `drill_app`). Nunca rode os testes com `DATABASE_URL` apontando para banco real.

### Comando exato por lote (o que o script executa)

Para rodar só alguns arquivos, ou depurar um lote:

```bash
node scripts/withDisposableDb.js --port 55801 -- env LOG_LEVEL=info \
  CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production \
  CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310 \
  bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco8/*.test.js"
```

`--port` é qualquer porta livre; o cluster é criado, usado e apagado no fim, mesmo se o teste falhar. Os segredos acima são fictícios (`*-not-for-production`) e valem apenas dentro do banco descartável.

Comando "oficial" sem lotes (equivale ao `npm test` rodando dentro de um único banco descartável):

```bash
node scripts/withDisposableDb.js --port 55801 -- env CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production \
  bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && npm test"
```

## 5. Tempo esperado

A suíte tem 244 arquivos e 1826 testes (commit 081fc440). Cada lote gasta cerca de 20 a 40 s para criar o cluster (migrations do zero) mais a execução dos testes. Na rodada de evidência (macOS, Apple Silicon, 4 lotes, `REGRESSAO_PARALELO=2`): lotes de 74 a 132 s de testes e **236 s no total**. Em série (`REGRESSAO_PARALELO=1`, padrão), conte de 6 a 10 minutos; em máquina mais lenta, até 30.

## 6. Como interpretar o log

- Cabeçalho `#`: commit avaliado, versão do PostgreSQL, do Node e do ClamAV, número de lotes.
- Seção `######## LOTE N (exit X) ########`: saída em formato `spec` de cada lote: `✔` passou, `✖` falhou, `﹣` pulado. Linhas JSON soltas são o log de requisições da API (não são resultado de teste).
- Seção final `RESUMO CONSOLIDADO`: `tests` = `pass` + `fail` + `cancelled` + `skipped` + `todo`. A regressão está aprovada quando `fail`, `cancelled` e `skipped` são 0 e o script termina com `APROVADA`.
- Para cada falha, procure o nome do teste (`✖`) e o bloco `failureType`/`error` logo abaixo, no final do lote. Para repetir só o arquivo suspeito, use o comando por lote da seção 4 com esse arquivo.
- Lote que termina **sem** linha `ℹ tests`: o preparo do banco falhou (olhe as últimas linhas de `regressao.loteN.log`); o script acusa e reprova.
- Falhas só de ambiente (ClamAV fora do ar, porta ocupada, disco cheio) aparecem como erro de conexão; corrija o ambiente e repita o lote.

Evidências já geradas por rodadas anteriores estão em `docs/evidencias/regressao/` (esta rodada) e `docs/evidencias/ci/` (logs do CI no GitHub Actions).
