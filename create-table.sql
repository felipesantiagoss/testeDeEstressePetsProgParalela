-- Cria a tabela "animais" apenas se ela ainda não existir (evita erro ao rodar o script de novo)
CREATE TABLE IF NOT EXISTS animais (
    id SERIAL PRIMARY KEY,                  -- Identificador único; SERIAL gera um número automático e crescente, PRIMARY KEY o define como chave primária
    nome VARCHAR(100) NOT NULL,             -- Nome do animal; texto de até 100 caracteres, obrigatório (NOT NULL = não pode ficar vazio)
    sexo VARCHAR(10) NOT NULL,              -- Sexo do animal (ex: 'macho' ou 'fêmea'); obrigatório
    porte VARCHAR(20) NOT NULL,             -- Porte do animal (ex: 'pequeno', 'médio', 'grande'); obrigatório
    idade VARCHAR(20) NOT NULL,             -- Faixa de idade (ex: 'filhote', 'adulto', 'idoso'); obrigatório
    cor VARCHAR(50) NOT NULL,               -- Cor da pelagem do animal; obrigatório
    raca VARCHAR(100) NOT NULL,             -- Raça do animal (ex: 'Labrador', 'Vira-lata'); obrigatório
    localizacao VARCHAR(255) NOT NULL,      -- Local onde o animal está (cidade/bairro); texto de até 255 caracteres, obrigatório
    descricao TEXT,                         -- Descrição livre sobre o animal; TEXT permite textos longos, opcional (pode ficar vazio)
    status CHAR(1) NOT NULL DEFAULT 'D'     -- Situação do animal; 1 caractere, obrigatório, valor padrão 'D'. 'D' para disponível ou 'I' para indisponível
);

-- Fila de jobs para processamento em background (paralelismo: fila + worker).
-- A API é a PRODUTORA: ao confirmar uma adoção, insere um job e responde na hora.
-- O worker (processo separado: npm run worker) é o CONSUMIDOR: pega jobs pendentes
-- com FOR UPDATE SKIP LOCKED, o que permite vários workers em paralelo sem que
-- dois peguem o mesmo job.
-- Cria a tabela "fila_notificacoes" apenas se ela ainda não existir (guarda os jobs a processar)
CREATE TABLE IF NOT EXISTS fila_notificacoes (
    id SERIAL PRIMARY KEY,               -- Identificador único do job; gerado automaticamente e usado como chave primária
    tipo VARCHAR(50) NOT NULL,           -- Tipo do job a executar; obrigatório. ex: 'adocao_confirmada'
    payload JSONB NOT NULL,              -- Dados do job em formato JSON (JSONB = JSON binário, mais rápido para consultar): { animalId, nome, usuarioId }
    status CHAR(1) NOT NULL DEFAULT 'P', -- Situação do job; valor padrão 'P'. 'P' pendente | 'C' concluído | 'E' erro
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),  -- Data/hora em que o job foi criado; preenchida automaticamente com o horário atual (now()). TIMESTAMPTZ guarda o fuso horário
    processado_em TIMESTAMPTZ,           -- Data/hora em que o job foi processado; fica vazia até o worker concluir
    processado_por VARCHAR(50)           -- Identificação de qual worker processou o job
);

-- Índice parcial: o worker só varre os pendentes, então o índice cobre apenas eles.
-- Cria o índice "idx_fila_pendentes" na coluna id da tabela fila_notificacoes, mas SÓ para as linhas com status = 'P'.
-- Isso acelera a busca dos jobs pendentes e ocupa menos espaço (não indexa os já processados).
CREATE INDEX IF NOT EXISTS idx_fila_pendentes ON fila_notificacoes (id) WHERE status = 'P';