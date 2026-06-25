# Petz — Sistema de Adoção de Animais

API REST para gerenciamento de animais disponíveis para adoção, desenvolvida com **Node.js**, **Express** e **PostgreSQL**.

O projeto demonstra, na prática, **controle de concorrência** (RF014) e **paralelismo com fila + worker**. É composto por **dois processos** que se comunicam por uma **fila persistida no banco**:

- **API** (`server.js`) — atende as requisições HTTP. Na adoção, resolve a
  concorrência com um `UPDATE` atômico (trava de linha) e **enfileira** a
  notificação do adotante;
- **Worker** (`worker.js`) — processo separado que **consome a fila em
  background** (envio simulado do e-mail de confirmação), de forma independente
  da requisição principal. Vários workers podem rodar em paralelo sem duplicar
  jobs (`FOR UPDATE SKIP LOCKED`).

---

## Sumário

- [Pré-requisitos](#pré-requisitos)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Banco de dados](#banco-de-dados)
  - [1. Criar o banco](#1-criar-o-banco)
  - [2. Criar as tabelas](#2-criar-as-tabelas)
  - [3. Popular o banco](#3-popular-o-banco)
  - [4. Configurar a conexão](#4-configurar-a-conexão)
  - [Consultas úteis (SELECTs)](#consultas-úteis-selects)
- [Instalação e execução](#instalação-e-execução)
  - [Subir a API](#subir-a-api)
  - [Subir o worker](#subir-o-worker)
  - [Scripts npm disponíveis](#scripts-npm-disponíveis)
- [Rotas da API](#rotas-da-api)
- [Paralelismo: fila + worker](#paralelismo-fila--worker)
- [Testes de estresse (RF014)](#testes-de-estresse-rf014)
  - [Como rodar 10, 100 e 1000 usuários](#como-rodar-10-100-e-1000-usuários)
  - [Demonstração da trava de linha](#demonstração-da-trava-de-linha)
  - [Artefatos e relatório HTML](#artefatos-e-relatório-html)
  - [Interpretação das métricas](#interpretação-das-métricas)
  - [Critérios de aprovação](#critérios-de-aprovação)
  - [Variáveis de ambiente](#variáveis-de-ambiente)

---

## Pré-requisitos

Antes de começar, certifique-se de ter instalado na sua máquina:

- [Node.js](https://nodejs.org/) versão **18 ou superior** (o projeto usa `fetch` nativo);
- [PostgreSQL](https://www.postgresql.org/) versão **14 ou superior**.

---

## Estrutura do projeto

```
.
├── create-table.sql                # Cria as tabelas (animais e fila_notificacoes)
├── insert.sql                      # Popula a tabela animais com 100 registros de exemplo
└── backend/
    ├── server.js                   # Entry point da API — inicia o servidor (porta 3001)
    ├── worker.js                   # Worker — consome a fila em background (processo separado)
    ├── package.json                # Dependências e scripts npm
    ├── scripts/                    # Testes de estresse e ferramentas de demonstração
    │   ├── stress-adocao.js        # Teste de adoção simples (N usuários, 1 animal)
    │   ├── stress-cenario.js       # Cenário com navegação + ondas de adoção (perfis: reduzido/cheio)
    │   ├── demo-trava.js           # Demonstra, com horários reais, quem vence a trava de linha
    │   ├── fila-status.js          # Visão da fila de notificações (npm run fila)
    │   └── lib/
    │       └── relatorio.js        # Estatísticas, throughput e geração do relatório HTML
    └── src/
        ├── app.js                  # Configuração do Express (CORS, JSON, rotas)
        ├── config/
        │   └── db.js               # Pool de conexões com o PostgreSQL
        ├── controllers/
        │   └── animaisController.js # Lógica de negócio (produz jobs na fila ao adotar)
        └── routes/
            └── animais.js          # Definição das rotas
```

---

## Banco de dados

### 1. Criar o banco

Abra o **pgAdmin** ou o terminal do PostgreSQL (`psql`) e crie o banco:

```sql
CREATE DATABASE petz;
```

### 2. Criar as tabelas

Com o banco `petz` selecionado, execute o conteúdo do arquivo
[`create-table.sql`](create-table.sql). Ele cria **duas tabelas** (de forma
idempotente, com `IF NOT EXISTS`):

**Tabela `animais`** — o catálogo de pets:

```sql
CREATE TABLE IF NOT EXISTS animais (
    id          SERIAL PRIMARY KEY,
    nome        VARCHAR(100) NOT NULL,
    sexo        VARCHAR(10)  NOT NULL,
    porte       VARCHAR(20)  NOT NULL,
    idade       VARCHAR(20)  NOT NULL,
    cor         VARCHAR(50)  NOT NULL,
    raca        VARCHAR(100) NOT NULL,
    localizacao VARCHAR(255) NOT NULL,
    descricao   TEXT,
    status      CHAR(1) NOT NULL DEFAULT 'D'  -- 'D' = disponível | 'I' = indisponível (adotado)
);
```

**Tabela `fila_notificacoes`** — a fila de jobs consumida pelo worker:

```sql
CREATE TABLE IF NOT EXISTS fila_notificacoes (
    id            SERIAL PRIMARY KEY,
    tipo          VARCHAR(50) NOT NULL,            -- ex.: 'adocao_confirmada'
    payload       JSONB NOT NULL,                  -- { animalId, nome, usuarioId }
    status        CHAR(1) NOT NULL DEFAULT 'P',    -- 'P' pendente | 'C' concluído | 'E' erro
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processado_em TIMESTAMPTZ,                     -- preenchido quando o worker conclui
    processado_por VARCHAR(50)                     -- qual worker processou o job
);

-- Índice parcial: o worker só varre os jobs pendentes.
CREATE INDEX IF NOT EXISTS idx_fila_pendentes
    ON fila_notificacoes (id) WHERE status = 'P';
```

> **Tabela `corrida_trava` (criada automaticamente).** Os testes de concorrência
> (`npm run stress` e `npm run trava`) criam e usam uma terceira tabela,
> `corrida_trava`, para registrar o instante **exato** em que cada usuário pegou
> a trava de linha. Você **não** precisa criá-la manualmente — os scripts já
> fazem isso (`CREATE TABLE IF NOT EXISTS` + `TRUNCATE` no início de cada
> execução). Sua estrutura é:
>
> ```sql
> CREATE TABLE IF NOT EXISTS corrida_trava (
>     id            SERIAL PRIMARY KEY,
>     animal_id     INT,
>     usuario       TEXT,
>     travou_em     TIMESTAMPTZ,        -- horário real da trava (precisão de microssegundos)
>     encontrou     CHAR(1),            -- status do animal quando este usuário pegou a trava
>     venceu        BOOLEAN,            -- true para quem efetivou a adoção
>     registrado_em TIMESTAMPTZ DEFAULT now()
> );
> ```

### 3. Popular o banco

Execute o conteúdo do arquivo [`insert.sql`](insert.sql) para inserir os **100
animais de exemplo**. No pgAdmin, abra o arquivo e clique em **Execute**. Pelo
terminal:

```bash
psql -U postgres -d petz -f insert.sql
```

### 4. Configurar a conexão

A conexão é definida em [`backend/src/config/db.js`](backend/src/config/db.js).
Todos os parâmetros têm um valor padrão e podem ser sobrescritos por **variáveis
de ambiente** — útil para não versionar senhas:

```js
const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '123456',   // ajuste para a sua senha
  database: process.env.PG_DATABASE || 'petz',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  max:      parseInt(process.env.PG_POOL_MAX || '10', 10), // tamanho do pool
});
```

| Variável       | Padrão       | Descrição                                  |
|----------------|--------------|--------------------------------------------|
| `PG_HOST`      | `localhost`  | Endereço do servidor PostgreSQL.           |
| `PG_USER`      | `postgres`   | Usuário do banco.                          |
| `PG_PASSWORD`  | `123456`     | Senha do banco.                            |
| `PG_DATABASE`  | `petz`       | Nome do banco.                             |
| `PG_PORT`      | `5432`       | Porta do PostgreSQL.                       |
| `PG_POOL_MAX`  | `10`         | Máximo de conexões simultâneas no pool.    |

> Edite diretamente o `db.js` **ou** exporte as variáveis (ex.:
> `PG_PASSWORD=minhasenha npm start`).

### Consultas úteis (SELECTs)

Consultas para acompanhar o estado do banco durante a operação e os testes
(execute no pgAdmin ou no `psql`):

**Listar os animais ainda disponíveis (alvos válidos para os testes):**

```sql
SELECT id, nome FROM animais WHERE status = 'D' ORDER BY id LIMIT 10;
```

**Conferir o status final de um animal (deve ficar `I` após adotado):**

```sql
SELECT id, nome, status FROM animais WHERE id = 1;
```

**Reativar animais para repetir os testes** (a adoção é definitiva: o animal não
volta sozinho para `D`):

```sql
UPDATE animais SET status = 'D' WHERE id IN (1, 2, 3, 4, 5);
```

**Resumo da fila de notificações por status:**

```sql
SELECT status, count(*) AS total
  FROM fila_notificacoes
 GROUP BY status
 ORDER BY status;   -- 'P' pendente | 'C' concluído | 'E' erro
```

**Últimos jobs da fila — quem foi enfileirado e qual worker processou:**

```sql
SELECT id, tipo, payload->>'nome' AS pet, payload->>'usuarioId' AS adotante,
       status, processado_por, criado_em, processado_em
  FROM fila_notificacoes
 ORDER BY id DESC
 LIMIT 15;
```

**Resultado da última corrida pela trava de linha** (preenchida por
`npm run stress` e `npm run trava` — mostra a ordem real e o vencedor):

```sql
SELECT usuario,
       to_char(travou_em, 'HH24:MI:SS.US') AS pegou_a_trava,
       encontrou, venceu
  FROM corrida_trava
 ORDER BY travou_em;
```

> Atalho: o comando `npm run fila` (na pasta `backend/`) imprime no terminal o
> resumo e os últimos jobs da fila, sem precisar abrir o pgAdmin.

---

## Instalação e execução

Instale as dependências do backend uma única vez:

```bash
cd backend
npm install
```

### Subir a API

```bash
npm start          # produção (node server.js)
# ou
npm run dev        # com recarga automática (nodemon)
```

O servidor sobe em **http://localhost:3001** e exibe
`Servidor rodando em http://localhost:3001`.

### Subir o worker

Em **outro terminal**, dentro de `backend/`:

```bash
npm run worker
```

O worker consome a fila `fila_notificacoes` em background. É possível subir
**vários em paralelo**, cada um com um nome, para demonstrar a distribuição de
jobs:

```bash
WORKER_ID=worker-A npm run worker   # terminal A
WORKER_ID=worker-B npm run worker   # terminal B
```

> A API funciona **mesmo sem o worker no ar**: os jobs ficam acumulados na fila
> (`status = 'P'`) e são processados assim que um worker subir. Encerre o worker
> com `Ctrl+C` — ele termina o job atual antes de sair (encerramento gracioso).

| Variável do worker | Padrão          | Descrição                                        |
|--------------------|-----------------|--------------------------------------------------|
| `WORKER_ID`        | `worker-<pid>`  | Nome do worker nos logs e na fila.               |
| `TRABALHO_MS`      | `1500`          | Duração simulada do processamento de 1 job (ms). |
| `POLL_MS`          | `1000`          | Intervalo de checagem quando a fila está vazia.  |

### Scripts npm disponíveis

Todos rodam a partir da pasta `backend/`:

| Comando                       | O que faz                                                                 |
|-------------------------------|---------------------------------------------------------------------------|
| `npm start`                   | Sobe a API (porta 3001).                                                   |
| `npm run dev`                 | Sobe a API com recarga automática (nodemon).                              |
| `npm run worker`              | Sobe um worker que consome a fila em background.                          |
| `npm run fila`                | Imprime o resumo e os últimos jobs da fila de notificações.              |
| `npm run trava`               | Demonstra, com horários reais, **por que** um usuário vence a trava.      |
| `npm run stress`              | Teste de adoção simples: N usuários disputam **1** animal.                |
| `npm run stress:cenario`      | Cenário **reduzido**: 100 usuários navegando + ondas de adoção (~100).    |
| `npm run stress:cenario:cheio`| Cenário **cheio**: 1000 usuários navegando + ondas de adoção (~1000).     |

---

## Rotas da API

Base URL: `http://localhost:3001/api/animais`

| Método   | Rota             | Descrição                                            |
|----------|------------------|------------------------------------------------------|
| `GET`    | `/`              | Lista todos os animais (aceita filtros).             |
| `GET`    | `/:id`           | Busca um animal pelo ID.                             |
| `POST`   | `/`              | Cadastra um novo animal.                             |
| `PUT`    | `/:id`           | Atualiza todos os dados de um animal.                |
| `DELETE` | `/:id`           | Remove um animal.                                    |
| `PATCH`  | `/:id/status`    | Alterna o status entre disponível e indisponível.    |
| `POST`   | `/:id/adotar`    | Adota um animal de forma atômica (concorrência-safe).|

### Filtros do `GET /`

Todos os parâmetros são opcionais e combináveis:

```
GET /api/animais?sexo=macho&porte=pequeno&idade=filhote&cor=preto&raca=labrador&localizacao=taguatinga
```

| Parâmetro     | Exemplo                       |
|---------------|-------------------------------|
| `sexo`        | `macho`, `fêmea`              |
| `porte`       | `pequeno`, `médio`, `grande`  |
| `idade`       | `filhote`, `adulto`, `idoso`  |
| `cor`         | `preto`, `caramelo`           |
| `raca`        | `labrador`, `vira-lata`       |
| `localizacao` | `taguatinga`, `asa sul`       |

> `raca` e `localizacao` usam `ILIKE` (correspondência parcial, sem diferenciar
> maiúsculas/minúsculas).

### Corpo para `POST` e `PUT`

```json
{
  "nome": "Thor",
  "sexo": "macho",
  "porte": "grande",
  "idade": "adulto",
  "cor": "preto",
  "raca": "Labrador",
  "localizacao": "Ceilândia, Brasília, DF",
  "descricao": "Muito brincalhão e enérgico.",
  "status": "D"
}
```

### Adoção atômica — `POST /:id/adotar`

A mudança de status ocorre em uma transação com `SELECT ... FOR UPDATE` seguido
de `UPDATE ... WHERE status = 'D'`, protegida pela trava de linha do PostgreSQL.
Apenas a **primeira** requisição a obter a trava encontra o animal disponível; as
demais recebem `409`.

Corpo da requisição:

```json
{ "usuarioId": "user-1" }
```

| Situação              | Status | Resposta (resumo)                                                                 |
|-----------------------|--------|----------------------------------------------------------------------------------|
| Adoção bem-sucedida   | `200`  | `{ "sucesso": true, "mensagem": "Adoção realizada", "animalId": 1, "jobId": 7 }`  |
| Animal já adotado     | `409`  | `{ "sucesso": false, "motivo": "Animal já foi adotado" }`                          |
| Animal não encontrado | `404`  | `{ "sucesso": false, "motivo": "Animal não encontrado" }`                          |

O campo `jobId` identifica o job de notificação **enfileirado** pela adoção
vencedora — processado depois, em background, pelo worker.

---

## Paralelismo: fila + worker

A adoção responde ao usuário imediatamente, mas o trabalho "pesado" (envio do
e-mail de confirmação) **não acontece dentro da requisição**: ele é processado em
background por outro processo. O fluxo é **produtor → fila → consumidor**:

```
POST /:id/adotar ─► UPDATE atômico (trava de linha) ─► INSERT na fila ─► resposta 200
                                                            │
                                                            ▼  (depois, em outro processo)
                                          worker.js: SELECT ... FOR UPDATE SKIP LOCKED
                                                     processa o job (e-mail simulado)
                                                     marca como concluído ('C')
```

- **Fila** — tabela `fila_notificacoes`: cada job tem `tipo`, `payload` (JSONB),
  `status` (`P`/`C`/`E`) e registra **qual worker** o processou e **quando**.
- **Produtor** — `adotar` em
  [`backend/src/controllers/animaisController.js`](backend/src/controllers/animaisController.js):
  após o `UPDATE` vencedor, insere o job e devolve o `jobId`. O enfileiramento é
  melhor-esforço: a adoção nunca falha por causa da fila.
- **Consumidor** — [`backend/worker.js`](backend/worker.js): loop que pega 1 job
  pendente por vez com `FOR UPDATE SKIP LOCKED` **dentro de uma transação**. Se o
  worker morrer no meio de um job, o rollback devolve o job à fila
  automaticamente — nenhum trabalho se perde.

### Por que `FOR UPDATE SKIP LOCKED`?

É o que torna o consumo **paralelo e seguro**: cada worker trava a linha do job
que pegou; os demais workers **pulam** as linhas travadas em vez de esperar.
Resultado: N workers consomem a mesma fila simultaneamente e cada job é entregue
a exatamente um worker — sem duplicação e sem coordenação extra.

### Como demonstrar

```bash
# Terminal 1 — API
npm start

# Terminais 2 e 3 — dois workers em paralelo
WORKER_ID=worker-A npm run worker
WORKER_ID=worker-B npm run worker

# Terminal 4 — gere adoções e observe os workers dividirem os jobs
npm run stress:cenario

# Visão da fila a qualquer momento:
npm run fila
```

Para evidenciar a **independência da requisição principal**: derrube os workers
(`Ctrl+C`), faça adoções (a API segue respondendo `200` e os jobs acumulam como
`P` — visível no `npm run fila`), suba o worker de novo e veja a fila ser drenada.

---

## Testes de estresse (RF014)

Os testes validam o **RF014**: o sistema deve controlar a concorrência quando
múltiplos usuários demonstram interesse simultâneo pelo mesmo animal, garantindo
que apenas **uma** adoção seja bem-sucedida por animal.

**Pré-requisitos:** PostgreSQL no ar com o banco `petz` criado e populado (passos
do [Banco de dados](#banco-de-dados)), dependências instaladas e a API em
execução (`npm start`).

### Como rodar 10, 100 e 1000 usuários

Use **dois terminais** na pasta `backend/`: um para a API (`npm start`) e outro
para os testes.

| Carga             | Comando                                          | O que executa                                                        |
|-------------------|--------------------------------------------------|----------------------------------------------------------------------|
| **10 usuários**   | `NUM_USUARIOS=10 npm run stress`                 | 10 usuários disputam **1** animal ao mesmo tempo (teste simples).    |
| **100 usuários**  | `npm run stress:cenario`                         | 100 usuários navegando + 5 ondas de adoção (~100 adotantes).         |
| **1000 usuários** | `ulimit -n 4096 && PG_POOL_MAX=50 npm run stress:cenario:cheio` | 1000 usuários navegando + 5 ondas de adoção (~1000 adotantes). |

> **Por que `ulimit` e `PG_POOL_MAX` no perfil de 1000?** Esse perfil abre
> milhares de conexões simultâneas. Elevar o limite de descritores de arquivo do
> sistema operacional (`ulimit -n 4096`) evita o erro `EMFILE: too many open
> files`, e aumentar o pool do PostgreSQL (`PG_POOL_MAX=50`) reduz a fila no pool
> e a latência p99. (No Windows, ignore o `ulimit`; ele é específico de
> Linux/macOS.)

**Teste simples — escolhendo o animal e a quantidade de usuários:**

```bash
ANIMAL_ID=50 NUM_USUARIOS=10 npm run stress
```

| Variável       | Padrão                  | Descrição                                                                 |
|----------------|-------------------------|---------------------------------------------------------------------------|
| `ANIMAL_ID`    | primeiro disponível     | ID do animal disputado. Sem informar, escolhe o primeiro com `status='D'`.|
| `NUM_USUARIOS` | `3`                     | Quantidade de usuários paralelos.                                         |
| `BASE_URL`     | `http://localhost:3001` | URL base da API.                                                          |

> A adoção é **definitiva**: uma vez adotado (`status = 'I'`), o animal não volta
> a ficar disponível. Para repetir, use um `ANIMAL_ID` ainda em `status = 'D'`
> (veja [Consultas úteis](#consultas-úteis-selects)) ou reative-o com
> `UPDATE animais SET status='D' WHERE id IN (...);`. O cenário
> (`npm run stress:cenario`) reativa os animais-alvo automaticamente.

**O que o cenário (`stress:cenario`) faz:**

1. Seleciona os 5 primeiros animais disponíveis e garante o `status = 'D'`.
2. Dispara os usuários de navegação (`GET /api/animais` e variações com filtros).
3. Em `t = 2s`, dispara 5 ondas de adoção em paralelo, uma por animal.
4. Imprime os resultados por animal, as métricas de navegação e gera o relatório.

Cada animal deve registrar **exatamente 1 vencedor** (total de 5 adoções
bem-sucedidas).

### Demonstração da trava de linha

```bash
npm run trava                # usa o primeiro animal disponível
ANIMAL_ID=1 NUM_USUARIOS=5 npm run trava
```

Este script **não depende da API** (fala direto com o banco) e é
**não-destrutivo**: ao final, devolve o animal para `status = 'D'`, então pode
ser repetido à vontade. Ele instrumenta a corrida com `clock_timestamp()`
(precisão de microssegundos) e mostra, com dados reais:

- a ordem **exata** em que cada usuário pegou a trava de linha;
- o atraso de cada um em relação ao primeiro;
- por que o vencedor (1º a pegar a trava, encontrou `'D'`) venceu e por que os
  demais perderam (pegaram a trava depois, já encontraram `'I'` → `409`).

Os horários são gravados na tabela `corrida_trava` — confira que batem com o
console usando o SELECT em [Consultas úteis](#consultas-úteis-selects).

### Artefatos e relatório HTML

Cada execução de `npm run stress` e `npm run stress:cenario` cria a pasta
`backend/out/<script>-<timestamp>/` com:

| Arquivo        | Conteúdo                                                                 |
|----------------|-------------------------------------------------------------------------|
| `log.jsonl`    | Registro bruto: uma linha JSON por requisição (tempos, status, etc.).   |
| `summary.json` | Resumo consolidado: configuração, cards, veredito e estatísticas.       |
| `report.html`  | Relatório visual navegável.                                             |

Para abrir o relatório no macOS:

```bash
open backend/out/<script>-<timestamp>/report.html
```

O relatório traz: **veredito** (aprovado/reprovado), **cards** de indicadores,
análise de **quem ganhou e por quê** (por animal), **timeline** da corrida,
**throughput**, **distribuição de latência**, **glossário** e a tabela completa
de **eventos**.

### Interpretação das métricas

**Resolução da concorrência.** A adoção executa
`UPDATE animais SET status='I' WHERE id=? AND status='D'`. O PostgreSQL aplica
uma **trava de linha** (*row lock*) sobre o registro: a primeira transação a
obter a trava encontra `status='D'`, efetua a alteração e retorna `rowCount=1`
(adoção bem-sucedida). As demais executam o mesmo comando quando o registro já
está `'I'`; o `WHERE` não casa, `rowCount=0`, e a API responde `409`. **A ordem
de chegada ao servidor e a latência observada no cliente não determinam o
vencedor — apenas a ordem de aquisição da trava de linha.**

**Campos de instrumentação** (presentes na resposta da adoção e no log):

| Campo          | Significado                                                                  |
|----------------|------------------------------------------------------------------------------|
| `recebidoEm`   | Instante em que o servidor recebeu a requisição.                             |
| `ordemChegada` | Ordem sequencial de chegada da requisição ao servidor.                      |
| `dbMs`         | Tempo no banco (fila do pool + aquisição da trava + execução do `UPDATE`).   |

**Latência e percentis.** Latência é o tempo de ida e volta de cada requisição
(medido no cliente). `p50` é a mediana; `p95` e `p99` evidenciam a cauda (piores
casos), calculados por interpolação linear.

**Throughput.** Requisições por segundo sobre a **janela real** de execução (do
envio da primeira requisição ao recebimento da última resposta) — normalmente
menor que a duração nominal, pois os usuários virtuais terminam antes do prazo.

**Status HTTP:** `200` = vencedor; `409` = animal já adotado (perdedores
corretos); `404` = animal inexistente; `5xx`/`0` = erro de servidor ou de rede.

### Critérios de aprovação

O teste é **aprovado** quando:

- ✅ o número de adoções bem-sucedidas (`200`) é exatamente **1 por animal** disputado;
- ✅ não há erros (`5xx` ou falhas de rede);
- ✅ o status final do animal no banco é `I`;
- ✅ as requisições perdedoras recebem `409`.

Duas ou mais adoções bem-sucedidas no mesmo animal caracterizam *race condition*
e violação do RF014.

### Variáveis de ambiente

| Variável       | Padrão                  | Aplica-se a             | Descrição                                          |
|----------------|-------------------------|-------------------------|----------------------------------------------------|
| `ANIMAL_ID`    | primeiro disponível     | `stress`, `trava`       | ID do animal disputado.                            |
| `NUM_USUARIOS` | `3`                     | `stress`, `trava`       | Quantidade de usuários paralelos.                  |
| `PERFIL`       | `reduzido`              | `stress:cenario`        | `reduzido` (100) ou `cheio` (1000).                |
| `BASE_URL`     | `http://localhost:3001` | todos os testes         | URL base da API.                                   |
| `PG_POOL_MAX`  | `10`                    | API, worker e testes    | Tamanho do pool de conexões do PostgreSQL.         |
| `PG_PASSWORD`  | `123456`                | API, worker e testes    | Senha do PostgreSQL.                               |

A estrutura dos perfis (quantidade de usuários, duração da navegação e ondas de
adoção) é definida na constante `PERFIS`, no início de
[`backend/scripts/stress-cenario.js`](backend/scripts/stress-cenario.js).
