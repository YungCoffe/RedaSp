'use strict';

const { SalaClient } = require('./sala');
const chaves = require('./subscriptionKey');

const MAX = 300;
const OCIOSO_MS = 30 * 60 * 1000;

const mapa = new Map();

function criar(userId) {
  const cliente = new SalaClient(chaves);
  mapa.set(userId, { cliente, visto: Date.now() });
  return cliente;
}

function obter(userId) {
  const item = mapa.get(userId);
  if (!item) return null;
  item.visto = Date.now();
  return item.cliente;
}

async function remover(userId) {
  const item = mapa.delete(userId) ? mapa.get(userId) : null;
  return item;
}

async function descartar(userId) {
  const item = mapa.get(userId);
  if (!item) return;
  mapa.delete(userId);
  await item.cliente.close().catch(() => {});
}

async function limpar() {
  const agora = Date.now();
  for (const [userId, item] of mapa) {
    if (agora - item.visto > OCIOSO_MS) await descartar(userId);
  }
  if (mapa.size > MAX) {
    const ordenado = [...mapa.entries()].sort((a, b) => a[1].visto - b[1].visto);
    for (const [userId] of ordenado.slice(0, mapa.size - MAX)) await descartar(userId);
  }
}

async function fecharTudo() {
  const clientes = [...mapa.values()].map((i) => i.cliente);
  mapa.clear();
  await Promise.allSettled(clientes.map((c) => c.close()));
}

module.exports = { criar, obter, descartar, limpar, fecharTudo, tamanho: () => mapa.size };