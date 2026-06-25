// Demonstração: POR QUE um usuário específico vence a corrida pela trava de linha.
//
// O teste de estresse normal não consegue cronometrar a trava (ela é decidida em
// microssegundos dentro do Postgres e não é instrumentada). Aqui nós INSTRUMENTAMOS:
// cada usuário registra o INSTANTE EXATO em que conseguiu a trava de linha, usando
// clock_timestamp() do PostgreSQL (precisão de microssegundos).
//
// Assim dá pra ordenar quem pegou a trava primeiro e PROVAR, com dados, por que
// aquele usuário venceu: ele chegou na trava primeiro, e naquele instante o animal
// ainda estava 'D'. Os outros chegaram microssegundos depois, já encontraram 'I'.
//
// É uma corrida REAL (Promise.all dispara todos juntos), então o vencedor muda a
// cada execução — rode de novo e veja. Só precisa do PostgreSQL no ar.

const pool = require('../src/config/db'); // Importa o pool de conexões com o banco PostgreSQL

const NUM = parseInt(process.env.NUM_USUARIOS || '3', 10); // Lê quantos usuários simular (padrão 3) da variável de ambiente
// Opcional: escolha o MESMO animal do seu teste (ex.: ANIMAL_ID=1 npm run trava).
// Sem informar, usa o primeiro disponível. A demo é não-destrutiva: ao final
// devolve o animal para 'D', então pode reaproveitar qualquer id.
const ANIMAL_ID = process.env.ANIMAL_ID ? parseInt(process.env.ANIMAL_ID, 10) : null; // Lê o id do animal da variável de ambiente; se não houver, fica null

// Um usuário tenta adotar. Mede o instante exato em que CONSEGUE a trava da linha.
async function tentarAdotar(animalId, usuario) { // Função onde UM usuário tenta adotar, medindo o instante da trava
  const client = await pool.connect(); // Pega uma conexão dedicada do pool (necessária para controlar a transação)
  try {
    await client.query('BEGIN'); // Inicia uma transação
    // SELECT ... FOR UPDATE bloqueia até ESTE usuário conseguir a trava da linha.
    // clock_timestamp()::text marca o instante (com microssegundos) em que a trava
    // foi concedida e a linha foi lida — convertido para texto para não perder
    // precisão (o driver arredondaria para milissegundos).
    // Lê a linha do animal com FOR UPDATE (trava a linha) e captura o instante exato da trava
    const r = await client.query(
      `SELECT status, clock_timestamp()::text AS travou_em
         FROM animais WHERE id = $1 FOR UPDATE`,
      [animalId]
    );
    const statusNaHora = r.rows[0].status; // o que ele encontrou ao pegar a trava
    const travouEm = r.rows[0].travou_em; // Instante (texto, com microssegundos) em que a trava foi obtida
    // A regra da adoção: só muda se ainda estiver 'D'.
    // Tenta mudar o status para 'I' apenas se ainda estiver 'D' (regra da adoção)
    const upd = await client.query(
      "UPDATE animais SET status='I' WHERE id=$1 AND status='D'",
      [animalId]
    );
    const venceu = upd.rowCount === 1; // Venceu se o UPDATE afetou exatamente 1 linha (encontrou o animal disponível)
    // Grava o horário REAL da trava na tabela corrida_trava, para você poder
    // conferir depois no banco (pgAdmin/psql). Guarda o mesmo valor capturado
    // no SELECT FOR UPDATE (texto → timestamptz preserva os microssegundos).
    // Insere o registro desta tentativa na tabela corrida_trava para conferência posterior
    await client.query(
      `INSERT INTO corrida_trava (animal_id, usuario, travou_em, encontrou, venceu)
       VALUES ($1, $2, $3::timestamptz, $4, $5)`,
      [animalId, usuario, travouEm, statusNaHora, venceu]
    );
    await client.query('COMMIT'); // Confirma a transação, liberando a trava da linha
    return { usuario, travouEm, statusNaHora, rowCount: upd.rowCount, venceu }; // Retorna os dados da tentativa
  } catch (e) { // Captura qualquer erro durante a transação
    await client.query('ROLLBACK').catch(() => {}); // Desfaz a transação (ignora erro do rollback)
    return { usuario, erro: e.message }; // Retorna o usuário e a mensagem de erro
  } finally {
    client.release(); // Devolve a conexão ao pool (sempre, com ou sem erro)
  }
}

async function main() { // Função principal que orquestra a demonstração da trava
  let animal; // Guardará o animal usado na demonstração
  if (ANIMAL_ID != null) { // Se o usuário informou um ANIMAL_ID específico
    // Animal escolhido pelo usuário. Como a demo é não-destrutiva (restaura 'D'
    // no fim), garante que ele esteja 'D' para a corrida acontecer.
    const { rows } = await pool.query('SELECT id, nome, status FROM animais WHERE id = $1', [ANIMAL_ID]); // Busca o animal informado
    if (rows.length === 0) { // Se o animal não existe
      console.error(`Animal id=${ANIMAL_ID} não existe.`); // Exibe erro
      await pool.end(); // Encerra a conexão
      process.exit(1); // Sai com código de erro
    }
    animal = rows[0]; // Armazena o animal encontrado
    if (animal.status !== 'D') { // Se o animal não está disponível
      await pool.query("UPDATE animais SET status='D' WHERE id=$1", [ANIMAL_ID]); // Reativa o animal para 'D'
      console.log(`(animal ${ANIMAL_ID} estava '${animal.status}'; reativado para 'D' para a demonstração)`); // Avisa que reativou
    }
  } else { // Se nenhum ANIMAL_ID foi informado, escolhe automaticamente
    const { rows } = await pool.query("SELECT id, nome FROM animais WHERE status='D' ORDER BY id LIMIT 1"); // Busca o primeiro animal disponível
    if (rows.length === 0) { // Se não há nenhum animal disponível
      console.error("Nenhum animal disponível ('D'). Reative: UPDATE animais SET status='D' WHERE id=1;"); // Exibe erro orientando reativação
      await pool.end(); // Encerra a conexão
      process.exit(1); // Sai com código de erro
    }
    animal = rows[0]; // Usa o primeiro animal disponível
  }

  console.log(''); // Linha em branco
  console.log('=== POR QUE UM USUÁRIO VENCE A CORRIDA PELA TRAVA DE LINHA ==='); // Título da demonstração
  console.log(`Animal: ${animal.id} (${animal.nome}) — status inicial: 'D' (disponível)`); // Mostra o animal e status inicial
  console.log(`${NUM} usuários disparam a adoção ao MESMO tempo (Promise.all).`); // Explica que os usuários disparam juntos
  console.log('Vamos cronometrar o instante exato em que cada um conseguiu a trava de linha.'); // Explica o objetivo de cronometrar a trava
  console.log(''); // Linha em branco

  // Tabela onde gravamos os horários da trava, para conferência posterior no
  // banco. Recriada/zerada a cada execução, então sempre reflete a última corrida.
  // Cria a tabela corrida_trava caso não exista, para registrar cada disputa pela trava
  await pool.query(`CREATE TABLE IF NOT EXISTS corrida_trava (
    id SERIAL PRIMARY KEY,
    animal_id INT,
    usuario TEXT,
    travou_em TIMESTAMPTZ,
    encontrou CHAR(1),
    venceu BOOLEAN,
    registrado_em TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query('TRUNCATE corrida_trava RESTART IDENTITY'); // Esvazia a tabela e reinicia o id, para refletir só esta execução

  const usuarios = Array.from({ length: NUM }, (_, i) => `user-${i + 1}`); // Gera os ids dos usuários: user-1, user-2, ...
  // Embaralha a ordem de DISPARO para simular o que a rede/sistema operacional
  // fazem no teste real (lá, qual requisição chega primeiro varia a cada vez).
  // Sem isso, nesta demo direta no banco o user-1 dispararia sempre primeiro.
  const ordemDisparo = [...usuarios].sort(() => Math.random() - 0.5); // Embaralha aleatoriamente a ordem de disparo dos usuários
  const resultados = (await Promise.all(ordemDisparo.map((u) => tentarAdotar(animal.id, u)))).filter((r) => !r.erro); // Dispara todas as tentativas juntas e mantém só as que não deram erro

  // Calcula, DENTRO do Postgres, a ordem real e o atraso de cada um em relação ao
  // primeiro a pegar a trava (em ms, com precisão de microssegundos).
  const nomes = resultados.map((r) => r.usuario); // Extrai a lista de nomes dos usuários
  const tempos = resultados.map((r) => r.travouEm); // Extrai a lista de instantes em que cada um pegou a trava
  // Usa o Postgres para ordenar pelos timestamps e calcular o atraso de cada um em relação ao primeiro
  const { rows: ordenados } = await pool.query(
    `SELECT t.usuario,
            to_char(t.ts, 'HH24:MI:SS.US') AS hms,
            round((EXTRACT(EPOCH FROM (t.ts - MIN(t.ts) OVER ())) * 1000)::numeric, 3) AS atraso_ms
       FROM unnest($1::text[], $2::timestamptz[]) AS t(usuario, ts)
      ORDER BY t.ts`,
    [nomes, tempos]
  );

  // junta a ordem cronométrica com o resultado (status encontrado, rowCount)
  const porUsuario = Object.fromEntries(resultados.map((r) => [r.usuario, r])); // Cria um mapa usuario -> resultado para busca rápida
  const linhas = ordenados.map((o, i) => ({ pos: i + 1, ...o, ...porUsuario[o.usuario] })); // Junta posição, dados cronométricos e resultado de cada usuário

  console.log('Ordem REAL de aquisição da trava (medida dentro do Postgres):'); // Cabeçalho da tabela de ordem da trava
  console.log(''); // Linha em branco
  console.log('  ordem | usuário | pegou a trava em | encontrou | mudou?  | resultado | atraso p/ o 1º'); // Cabeçalho das colunas
  console.log('  ' + '-'.repeat(82)); // Linha separadora com 82 traços
  for (const l of linhas) { // Percorre cada linha (cada usuário, em ordem de trava)
    const mudou = l.rowCount === 1 ? 'SIM (1)' : 'não (0)'; // Indica se o UPDATE alterou a linha (1) ou não (0)
    const res = l.venceu ? '🏆 200' : '409'; // Resultado: vitória (200) ou conflito (409)
    const atraso = l.pos === 1 ? '—' : `+${l.atraso_ms}ms`; // Atraso em relação ao primeiro ('—' para o próprio primeiro)
    // Imprime a linha alinhando cada coluna com padEnd
    console.log(
      `  ${(l.pos + 'º').padEnd(5)} | ${l.usuario.padEnd(7)} | ${l.hms.padEnd(16)} | ${('  ' + l.statusNaHora).padEnd(9)} | ${mudou.padEnd(7)} | ${res.padEnd(9)} | ${atraso}`
    );
  }
  console.log(''); // Linha em branco

  const venc = linhas.find((l) => l.venceu); // Encontra a linha do vencedor
  const segundo = linhas.find((l) => l.pos === 2); // Encontra a linha do segundo colocado

  if (venc) { // Se houve um vencedor, explica a vitória
    console.log(`🏁 POR QUE "${venc.usuario}" VENCEU:`); // Cabeçalho da explicação da vitória
    console.log(`   • Foi o 1º a CONSEGUIR a trava de linha (às ${venc.hms}).`); // Foi o primeiro a pegar a trava
    console.log(`   • Naquele instante o animal ainda estava '${venc.statusNaHora}' (disponível).`); // Naquele momento o animal estava disponível
    console.log(`   • Por isso seu  UPDATE ... WHERE status='D'  encontrou a linha e mudou D→I (rowCount=1).`); // Por isso o UPDATE funcionou
    if (segundo) { // Se existe um segundo colocado
      console.log(`   • Ele venceu o 2º colocado ("${segundo.usuario}") por ${segundo.atraso_ms}ms.`); // Mostra por quanto venceu o segundo
      console.log(`     Foi essa fração de tempo — quem encostou na trava primeiro — que decidiu tudo.`); // Enfatiza que a trava decidiu
    }
    console.log(''); // Linha em branco
    console.log('❌ POR QUE OS OUTROS PERDERAM:'); // Cabeçalho da explicação das derrotas
    for (const l of linhas.filter((x) => !x.venceu)) { // Percorre todos os perdedores
      // Explica que o perdedor pegou a trava depois, quando o animal já era 'I'
      console.log(
        `   • "${l.usuario}" só conseguiu a trava ${l.atraso_ms}ms depois. Aí o animal JÁ era 'I'.`
      );
      // Explica que o UPDATE não encontrou nada (rowCount=0) e por isso retornou 409
      console.log(
        `     Seu  UPDATE ... WHERE status='D'  não encontrou nada (rowCount=0) → 409.`
      );
    }
  }
  // --- Verificação automática: os timestamps batem com a regra da trava? ---
  // A trava de linha GARANTE que só o primeiro a pegá-la encontra o animal 'D'.
  // Logo, o vencedor (rowCount=1) TEM que ser o de menor timestamp e ter achado
  // 'D'; os perdedores (rowCount=0) TÊM que ter achado 'I'. Se isso bate em toda
  // execução, os horários são fiéis. Se algum dia não batesse, seria um bug.
  const vencedores = linhas.filter((l) => l.venceu); // Lista de vencedores (deveria ter exatamente 1)
  const okUnico = vencedores.length === 1; // Verifica se houve exatamente 1 vencedor
  const okPrimeiro = okUnico && linhas[0].venceu; // menor timestamp = vencedor
  const okAchouD = okUnico && vencedores[0].statusNaHora === 'D'; // Verifica se o vencedor encontrou o animal em 'D'
  const okPerdedores = linhas.filter((l) => !l.venceu).every((l) => l.statusNaHora === 'I'); // Verifica se todos os perdedores encontraram 'I'
  const tudoOk = okUnico && okPrimeiro && okAchouD && okPerdedores; // Verdadeiro só se todas as verificações passarem
  console.log(''); // Linha em branco
  console.log('🔎 VERIFICAÇÃO AUTOMÁTICA (os horários conferem com a regra da trava?):'); // Cabeçalho da verificação automática
  console.log(`   ${okUnico ? '✓' : '✗'} Exatamente 1 vencedor (rowCount=1).`); // Resultado da checagem de vencedor único
  console.log(`   ${okPrimeiro ? '✓' : '✗'} O vencedor é o de MENOR timestamp (pegou a trava primeiro).`); // Resultado da checagem de quem pegou a trava primeiro
  console.log(`   ${okAchouD ? '✓' : '✗'} O vencedor encontrou o animal em 'D'.`); // Resultado da checagem do status encontrado pelo vencedor
  console.log(`   ${okPerdedores ? '✓' : '✗'} Todos os perdedores encontraram o animal em 'I'.`); // Resultado da checagem do status encontrado pelos perdedores
  // Conclusão geral da verificação: consistente ou inconsistente
  console.log(
    `   → ${tudoOk ? 'CONSISTENTE: os horários confirmam o resultado da corrida.' : 'INCONSISTENTE — algo está errado!'}`
  );
  console.log(''); // Linha em branco
  console.log('💾 Os horários acima foram GRAVADOS no banco (tabela corrida_trava).'); // Lembra que os dados foram salvos no banco
  console.log('   Confira você mesmo, no pgAdmin ou psql, que são os mesmos:'); // Convida a conferir no banco
  console.log("     SELECT usuario, to_char(travou_em,'HH24:MI:SS.US') AS pegou_a_trava,"); // Mostra o SELECT de conferência (parte 1)
  console.log('            encontrou, venceu FROM corrida_trava ORDER BY travou_em;'); // Mostra o SELECT de conferência (parte 2)
  console.log(''); // Linha em branco
  console.log('   Outras fontes independentes do Postgres:'); // Sugere outras formas de verificar
  console.log('   • pg_stat_activity / pg_locks — as travas ativas, ao vivo, dentro do banco;'); // Aponta as views de atividade/travas
  console.log("   • log do servidor PostgreSQL com log_lock_waits=on — registra cada espera de trava."); // Aponta o log de esperas de trava

  console.log(''); // Linha em branco
  console.log('CONCLUSÃO: o vencedor é quem PEGA A TRAVA PRIMEIRO. A diferença foi de'); // Conclusão final (parte 1)
  console.log('microssegundos/milissegundos — decidida por qual requisição chegou à trava na'); // Conclusão final (parte 2)
  console.log('frente. Rode de novo: o vencedor muda, mas é SEMPRE o primeiro a pegar a trava.'); // Conclusão final (parte 3)

  // Restaura o animal para repetir.
  await pool.query("UPDATE animais SET status='D' WHERE id=$1", [animal.id]); // Devolve o animal para 'D' (demo não-destrutiva)
  console.log(''); // Linha em branco
  console.log(`(animal ${animal.id} restaurado para 'D' — pode rodar de novo: npm run trava)`); // Avisa que o animal foi restaurado

  await pool.end(); // Encerra a conexão com o banco
}

main().catch(async (err) => { // Executa a função principal e captura qualquer erro não tratado
  console.error('Erro na demonstração:', err.message); // Exibe a mensagem do erro
  await pool.end().catch(() => {}); // Tenta encerrar a conexão (ignora erro)
  process.exit(1); // Sai com código de erro
});
