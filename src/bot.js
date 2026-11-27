'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const {
  Client, GatewayIntentBits, Events, MessageFlags, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  escapeMarkdown, escapeMentions, AttachmentBuilder, PermissionFlagsBits,
} = require('discord.js');

const gemini = require('./gemini');
const sessoes = require('./sessoes');
const {
  AuthenticationError, AccessError, ProtocolError, UpstreamError, DraftUnavailable,
  WriteOutcomeUnknown, SalaError,
} = require('./sala');

const TIMEOUT_BACKEND = 30_000;
const MAX_LISTA = 25;
const COOLDOWN_LOGIN = 15_000;
const COOLDOWN_GERAR = 60_000;
const TTL_PENDENTE = 30 * 60 * 1000;

const ultimoLogin = new Map();
const ultimaGeracao = new Map();
const pendentes = new Map();
let gerandoAgora = 0;
const MAX_GERACAO = 3;

function clean(value, limite = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const texto = String(value).replace(/\r/g, ' ').slice(0, limite);
  return escapeMarkdown(escapeMentions(texto, { ignoreInline: false }));
}

function idValido(valor) {
  return typeof valor === 'string' && valor.length >= 1 && valor.length <= 100 &&
    [...valor].every((c) => /[A-Za-z0-9_-]/.test(c));
}

async function comPrazo(promessa) {
  let timer;
  try {
    return await Promise.race([
      promessa,
      new Promise((_, rejeitar) => { timer = setTimeout(() => rejeitar(new Error('timeout')), TIMEOUT_BACKEND); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function botao(id, label, estilo, desabilitado = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(estilo).setDisabled(desabilitado);
}

function guardarPendente(dados) {
  const nonce = crypto.randomBytes(6).toString('base64url');
  pendentes.set(nonce, { ...dados, expira: Date.now() + TTL_PENDENTE });
  return nonce;
}

function lerPendente(nonce, userId) {
  const item = pendentes.get(nonce);
  if (!item || item.expira < Date.now() || item.userId !== userId) return null;
  return item;
}

function painel() {
  return {
    content: [
      '**Redações — Sala do Futuro**',
      '',
      '**Entrar** abre uma janela privada para RA, dígito, UF e senha. A senha não fica salva.',
      '**Usar o sistema** mostra suas redações pendentes para escolher e gerar o texto com IA.',
      '**Sair** encerra a sua sessão e descarta os tokens.',
      '',
      'Tudo depois disso aparece só para você. O bot apenas grava rascunho — a entrega é na plataforma.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(
      botao('painel:login', 'Entrar', ButtonStyle.Primary),
      botao('painel:usar', 'Usar o sistema', ButtonStyle.Success),
      botao('painel:sair', 'Sair', ButtonStyle.Secondary),
    )],
  };
}

function resumo(detalhe) {
  const linhas = [`Tarefa \`${detalhe.id}\``];
  const tema = clean(detalhe.statement || detalhe.description, 500);
  if (tema) linhas.push(`Tema: ${tema}`);
  if (detalhe.minChars || detalhe.maxChars) {
    const partes = [];
    if (detalhe.minChars) partes.push(`mínimo ${detalhe.minChars}`);
    if (detalhe.maxChars) partes.push(`máximo ${detalhe.maxChars}`);
    linhas.push('Limite de caracteres: ' + partes.join(', '));
  } else {
    linhas.push('Limite de caracteres não informado pela plataforma.');
  }
  if (detalhe.draft) {
    linhas.push(`Já existe rascunho com ${(detalhe.draft.body || '').length} caracteres; será substituído.`);
  }
  return linhas.join('\n');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const comandos = [
  {
    name: 'painel', description: 'Publica o painel com os botões de entrar, usar e sair',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
];

/* ---------- painel ---------- */

async function publicarPainel(interaction) {
  await interaction.reply(painel());
}

async function garantirPainel() {
  const canalId = (process.env.PANEL_CHANNEL_ID || '').trim();
  if (!canalId) return;
  try {
    const canal = await client.channels.fetch(canalId);
    if (!canal?.isTextBased()) return;
    const mensagens = await canal.messages.fetch({ limit: 50 });
    const existente = mensagens.find((m) =>
      m.author.id === client.user.id &&
      m.components?.[0]?.components?.[0]?.customId === 'painel:login');
    if (existente) await existente.edit(painel());
    else await canal.send(painel());
  } catch {
    console.error('Não foi possível garantir o painel no canal configurado.');
  }
}

/* ---------- login ---------- */

function modalLogin() {
  const modal = new ModalBuilder().setCustomId('login').setTitle('Entrar na Sala do Futuro');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ra').setLabel('RA (somente números)').setStyle(TextInputStyle.Short)
      .setMinLength(6).setMaxLength(12)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('digito').setLabel('Dígito').setStyle(TextInputStyle.Short).setMaxLength(2)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('uf').setLabel('UF').setStyle(TextInputStyle.Short).setMaxLength(2)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('senha').setLabel('Senha SED').setStyle(TextInputStyle.Short).setMaxLength(256)),
  );
  return modal;
}

async function iniciarLogin(interaction) {
  if (sessoes.obter(interaction.user.id)) {
    return interaction.reply({ content: 'Você já tem uma sessão aberta. Use **Sair** no painel antes.', flags: MessageFlags.Ephemeral });
  }
  const agora = Date.now();
  const anterior = ultimoLogin.get(interaction.user.id) || 0;
  if (agora - anterior < COOLDOWN_LOGIN) {
    const falta = Math.ceil((COOLDOWN_LOGIN - (agora - anterior)) / 1000);
    return interaction.reply({ content: `Aguarde ${falta}s para tentar de novo.`, flags: MessageFlags.Ephemeral });
  }
  return interaction.showModal(modalLogin());
}

async function modalLoginEnvio(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ra = interaction.fields.getTextInputValue('ra').replace(/\D/g, '');
  const digito = interaction.fields.getTextInputValue('digito').trim().toUpperCase();
  const uf = interaction.fields.getTextInputValue('uf').trim().toUpperCase();
  const senha = interaction.fields.getTextInputValue('senha');

  if (ra.length < 6 || ra.length > 12 || !/^[0-9A-Z]{1,2}$/.test(digito) || !/^[A-Z]{2}$/.test(uf)) {
    return interaction.editReply('RA, dígito ou UF em formato inválido.');
  }
  const usuario = ra.replace(/^0+/, '') + digito + uf;

  await sessoes.descartar(interaction.user.id);
  const cliente = sessoes.criar(interaction.user.id);
  try {
    await comPrazo(cliente.login(usuario, senha));
  } catch (erro) {
    await sessoes.descartar(interaction.user.id);
    if (erro instanceof AuthenticationError) {
      return interaction.editReply('Login recusado pela plataforma. Confira RA, dígito, UF e senha.');
    }
    return interaction.editReply('Não foi possível concluir o login agora. Tente em instantes.');
  }
  ultimoLogin.set(interaction.user.id, Date.now());
  return interaction.editReply('Sessão iniciada. Clique em **Usar o sistema** no painel.');
}

async function iniciarSaida(interaction) {
  if (!sessoes.obter(interaction.user.id)) {
    return interaction.reply({ content: 'Você não está logado.', flags: MessageFlags.Ephemeral });
  }
  await sessoes.descartar(interaction.user.id);
  return interaction.reply({ content: 'Sessão encerrada.', flags: MessageFlags.Ephemeral });
}

/* ---------- lista ---------- */

async function abrirLista(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cliente = sessoes.obter(interaction.user.id);
  if (!cliente) return interaction.editReply('Você não está logado. Clique em **Entrar** no painel.');

  let lista;
  try {
    lista = await comPrazo(cliente.listEssays());
  } catch {
    return interaction.editReply('Não foi possível listar as redações agora.');
  }
  const tarefas = lista.data.filter((t) => idValido(t.id));
  if (!tarefas.length) {
    return interaction.editReply('Nenhuma redação pendente encontrada. A lista pode ser incompleta; confira na plataforma.');
  }

  const opcoes = tarefas.slice(0, MAX_LISTA).map((t) => {
    const rotulo = clean(t.title, 80) || '(sem título)';
    const marca = t.status === 'draft' ? ' • rascunho' : '';
    const descricao = (clean(t.dueDate, 80) || 'sem prazo informado') + marca;
    return { label: rotulo, value: t.id, description: descricao.slice(0, 100) };
  });
  const nota = tarefas.length > MAX_LISTA ? `\nMostrando ${MAX_LISTA} de ${tarefas.length}.` : '';

  return interaction.editReply({
    content: `Escolha a redação que quer fazer:${nota}`,
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('lista').setPlaceholder('Escolha a redação').addOptions(opcoes)),
      new ActionRowBuilder().addComponents(botao('acao:sair', 'Sair da conta', ButtonStyle.Secondary)),
    ],
  });
}

async function abrirRedacao(interaction, id) {
  await interaction.deferUpdate();
  const cliente = sessoes.obter(interaction.user.id);
  if (!cliente) return interaction.editReply({ content: 'Sessão expirada. Clique em **Entrar** no painel.', components: [] });
  if (!idValido(id)) return interaction.editReply({ content: 'ID inválido.', components: [] });

  let detalhe;
  try {
    detalhe = await comPrazo(cliente.getDetail(id));
  } catch {
    return interaction.editReply({ content: 'Não foi possível abrir a redação.', components: [] });
  }
  return interaction.editReply({
    content: resumo(detalhe),
    components: [new ActionRowBuilder().addComponents(
      botao(`acao:gerar:${id}`, 'Gerar com IA', ButtonStyle.Primary),
      botao(`acao:manual:${id}`, 'Salvar sem IA', ButtonStyle.Secondary),
      botao(`acao:enunciado:${id}`, 'Enunciado completo', ButtonStyle.Secondary),
      botao('acao:sair', 'Sair', ButtonStyle.Secondary),
    )],
  });
}

async function mostrarEnunciado(interaction, id) {
  await interaction.deferUpdate();
  const cliente = sessoes.obter(interaction.user.id);
  if (!cliente) return interaction.editReply({ content: 'Sessão expirada.', components: [] });

  let detalhe;
  try {
    detalhe = await comPrazo(cliente.getDetail(id));
  } catch {
    return interaction.followUp({ content: 'Não foi possível abrir o enunciado.', flags: MessageFlags.Ephemeral });
  }
  const texto = (detalhe.statement || detalhe.description || '').trim();
  if (!texto) return interaction.followUp({ content: 'Enunciado não disponível.', flags: MessageFlags.Ephemeral });
  const arquivo = new AttachmentBuilder(Buffer.from(texto, 'utf8'), { name: `tema-${id}.txt` });
  return interaction.followUp({ content: 'Enunciado completo:', files: [arquivo], flags: MessageFlags.Ephemeral });
}

/* ---------- rascunho manual ---------- */

function modalRascunho(id) {
  const modal = new ModalBuilder().setCustomId(`rascunho:${id}`).setTitle('Rascunho manual');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('titulo').setLabel('Título').setStyle(TextInputStyle.Short).setMaxLength(200)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('texto').setLabel('Texto').setStyle(TextInputStyle.Paragraph).setMaxLength(4000)),
  );
  return modal;
}

async function modalRascunhoEnvio(interaction, id) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return salvar(interaction, id, interaction.fields.getTextInputValue('titulo'),
    interaction.fields.getTextInputValue('texto'));
}

/* ---------- geração ---------- */

async function gerar(interaction, id, instrucoes = '') {
  await interaction.deferUpdate();
  const cliente = sessoes.obter(interaction.user.id);
  if (!cliente) return interaction.editReply({ content: 'Sessão expirada. Clique em **Entrar** no painel.', components: [] });
  if (!idValido(id)) return interaction.editReply({ content: 'ID inválido.', components: [] });

  const agora = Date.now();
  const anterior = ultimaGeracao.get(interaction.user.id) || 0;
  if (agora - anterior < COOLDOWN_GERAR) {
    const falta = Math.ceil((COOLDOWN_GERAR - (agora - anterior)) / 1000);
    return interaction.editReply({ content: `Aguarde ${falta}s antes de gerar de novo.`, components: [] });
  }
  if (gerandoAgora >= MAX_GERACAO) {
    return interaction.editReply({ content: 'Muitas gerações simultâneas. Tente em instantes.', components: [] });
  }

  let detalhe;
  try {
    detalhe = await comPrazo(cliente.getDetail(id));
  } catch {
    return interaction.editReply({ content: 'Não foi possível abrir a redação.', components: [] });
  }
  const tema = (detalhe.statement || detalhe.description || detalhe.title || '').trim();
  if (!tema) return interaction.editReply({ content: 'Sem tema disponível para gerar.', components: [] });

  gerandoAgora += 1;
  let resultado;
  try {
    resultado = await gemini.generate(tema, detalhe.minChars, detalhe.maxChars, instrucoes);
  } catch (erro) {
    const texto = erro instanceof gemini.GeminiError ? erro.message : 'Falha na geração.';
    return interaction.editReply({ content: `Não deu: ${texto}`, components: [] });
  } finally {
    gerandoAgora -= 1;
    ultimaGeracao.set(interaction.user.id, Date.now());
  }

  const nonce = guardarPendente({
    userId: interaction.user.id, taskId: id, instrucoes,
    titulo: resultado.titulo, texto: resultado.texto,
  });

  const cabecalho = [
    `Título sugerido: ${clean(resultado.titulo, 200)}`,
    `${resultado.texto.length} caracteres (faixa usada: ${resultado.minimo}–${resultado.maximo}` +
      `${resultado.limitesInformados ? '' : ', limites não informados'})`,
    `Modelo: \`${resultado.modelo}\``,
  ];
  if (!resultado.dentro) cabecalho.push('Atenção: ficou fora da faixa após as tentativas.');
  if (resultado.tentativas > 1) cabecalho.push(`Tentativas: ${resultado.tentativas}`);

  const arquivo = new AttachmentBuilder(Buffer.from(resultado.texto, 'utf8'), { name: `redacao-${id}.txt` });
  return interaction.editReply({
    content: cabecalho.join('\n'),
    files: [arquivo],
    components: [new ActionRowBuilder().addComponents(
      botao(`salvar:${nonce}`, 'Salvar como rascunho', ButtonStyle.Success),
      botao(`regerar:${nonce}`, 'Gerar de novo', ButtonStyle.Primary),
    )],
  });
}

async function regerar(interaction, nonce) {
  const item = lerPendente(nonce, interaction.user.id);
  if (!item) return interaction.update({ content: 'Esta geração expirou. Use **Usar o sistema** de novo.', components: [], files: [] });
  return gerar(interaction, item.taskId, item.instrucoes);
}

/* ---------- salvamento ---------- */

async function salvar(interaction, id, titulo, texto) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const cliente = sessoes.obter(interaction.user.id);
  if (!cliente) return interaction.editReply({ content: 'Sessão expirada. Clique em **Entrar** no painel.', components: [] });

  let mensagem;
  try {
    const resultado = await comPrazo(cliente.saveDraft(id, titulo, texto));
    mensagem = `Rascunho salvo via ${resultado.metodo} (identificador ${resultado.rascunhoId || 'não confirmado'}). Não é entrega final.`;
    if (resultado.avisos.length) mensagem += ' ' + resultado.avisos.join(' ');
  } catch (erro) {
    if (erro instanceof WriteOutcomeUnknown) {
      mensagem = 'Não foi possível confirmar. O resultado é incerto: confira o rascunho na plataforma antes de tentar de novo.';
    } else if (erro instanceof DraftUnavailable || erro instanceof RangeError) {
      mensagem = erro.message;
    } else if (erro instanceof AccessError) {
      mensagem = 'Acesso negado ao salvar; confira a redação na plataforma.';
    } else if (erro instanceof ProtocolError || erro instanceof UpstreamError || erro instanceof SalaError) {
      mensagem = 'Falha ao salvar; nada confirmado. Confira na plataforma.';
    } else {
      mensagem = 'Falha inesperada ao salvar.';
    }
  }
  return interaction.editReply({ content: mensagem, components: [] });
}

async function salvarPendente(interaction, nonce) {
  const item = lerPendente(nonce, interaction.user.id);
  if (!item) return interaction.update({ content: 'Esta geração expirou. Use **Usar o sistema** de novo.', components: [], files: [] });
  return salvar(interaction, item.taskId, item.titulo, item.texto);
}

/* ---------- roteamento ---------- */

client.once(Events.ClientReady, async (c) => {
  const guildId = (process.env.GUILD_ID || '').trim();
  const alvo = guildId ? c.guilds.cache.get(guildId) : c.application;
  await alvo.commands.set(comandos);
  await garantirPainel();
  console.log(`Online como ${c.user.tag} (${sessoes.tamanho()} sessões)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'painel') return await publicarPainel(interaction);
      return undefined;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'login') return await modalLoginEnvio(interaction);
      if (interaction.customId.startsWith('rascunho:')) {
        return await modalRascunhoEnvio(interaction, interaction.customId.split(':')[1]);
      }
      return undefined;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'lista') {
      return await abrirRedacao(interaction, interaction.values[0]);
    }

    if (interaction.isButton()) {
      const [raiz, acao, extra] = interaction.customId.split(':');
      if (raiz === 'painel') {
        if (acao === 'login') return await iniciarLogin(interaction);
        if (acao === 'usar') return await abrirLista(interaction);
        if (acao === 'sair') return await iniciarSaida(interaction);
        return undefined;
      }
      if (raiz === 'acao') {
        if (acao === 'sair') {
          await sessoes.descartar(interaction.user.id);
          return interaction.update({ content: 'Sessão encerrada. Volte ao painel para entrar de novo.', components: [], files: [] });
        }
        if (acao === 'gerar') return await gerar(interaction, extra);
        if (acao === 'enunciado') return await mostrarEnunciado(interaction, extra);
        if (acao === 'manual') return interaction.showModal(modalRascunho(extra));
        return undefined;
      }
      if (raiz === 'salvar') return await salvarPendente(interaction, acao);
      if (raiz === 'regerar') return await regerar(interaction, acao);
      return undefined;
    }

    return undefined;
  } catch (erro) {
    console.error('Falha na interação:', erro?.constructor?.name || 'erro');
    const aviso = 'Falha inesperada ao processar.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: aviso, components: [] });
      else await interaction.reply({ content: aviso, flags: MessageFlags.Ephemeral });
    } catch { /* ignora */ }
  }
});

const varredura = setInterval(() => {
  sessoes.limpar().catch(() => {});
  const agora = Date.now();
  for (const [nonce, item] of pendentes) if (item.expira < agora) pendentes.delete(nonce);
  for (const mapa of [ultimaGeracao, ultimoLogin]) {
    for (const [userId, quando] of mapa) if (agora - quando > 10 * 60_000) mapa.delete(userId);
  }
}, 60_000);
varredura.unref();

const porta = Number(process.env.PORT || 0);
if (porta) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  }).listen(porta, '0.0.0.0');
}

async function encerrar() {
  clearInterval(varredura);
  await sessoes.fecharTudo();
  await client.destroy();
  process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('DISCORD_TOKEN ausente.');
  process.exit(1);
}
client.login(token);