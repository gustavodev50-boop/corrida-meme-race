import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { WebcastPushConnection } from 'tiktok-live-connector';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let tiktokConnection = null;
let gameWinner = null;

let gameState = {
  flamengo: { percent: 0, kmh: 0, name: 'FLAMENGO' },
  palmeiras: { percent: 0, kmh: 0, name: 'PALMEIRAS' },
  leader: null,
  lastEvent: null,
  winner: null
};

function resetGame(teamA, teamB) {
  gameWinner = null;
  gameState = {
    flamengo: { percent: 0, kmh: 0, name: teamA || 'FLAMENGO' },
    palmeiras: { percent: 0, kmh: 0, name: teamB || 'PALMEIRAS' },
    leader: null,
    lastEvent: null,
    winner: null
  };
}

function checkLeader() {
  const f = gameState.flamengo.percent;
  const p = gameState.palmeiras.percent;
  const oldLeader = gameState.leader;
  const newLeader = f > p ? 'flamengo' : p > f ? 'palmeiras' : null;
  if (newLeader && newLeader !== oldLeader) {
    gameState.leader = newLeader;
    return true;
  }
  return false;
}

function checkWinner() {
  if (gameWinner) return null;
  if (gameState.flamengo.percent >= 100) {
    gameWinner = 'flamengo';
    gameState.winner = 'flamengo';
    return 'flamengo';
  }
  if (gameState.palmeiras.percent >= 100) {
    gameWinner = 'palmeiras';
    gameState.winner = 'palmeiras';
    return 'palmeiras';
  }
  return null;
}

function applyBoost(team, boost, sound, effect, nickname, giftName, repeatCount) {
  if (effect === 'tropeco' || effect === 'escorregao') {
    // Penalty hits the leader
    const leaderTeam = gameState.flamengo.percent > gameState.palmeiras.percent ? 'flamengo' : 'palmeiras';
    gameState[leaderTeam].percent = Math.max(0, gameState[leaderTeam].percent + boost);
    gameState[leaderTeam].kmh = 70 + gameState[leaderTeam].percent * 0.5;
    gameState.lastEvent = {
      type: 'tropeco',
      team: leaderTeam,
      text: `${nickname} causou TROPEÇO em ${gameState[leaderTeam].name}! (${boost}%)`,
      sound,
      gift: giftName,
      sender: nickname
    };
  } else {
    // Boost goes to the trailing team
    const trailingTeam = gameState.flamengo.percent <= gameState.palmeiras.percent ? 'flamengo' : 'palmeiras';
    gameState[trailingTeam].percent = Math.min(100, gameState[trailingTeam].percent + boost);
    gameState[trailingTeam].kmh = 70 + gameState[trailingTeam].percent * 0.5;
    gameState.lastEvent = {
      type: 'gift',
      team: trailingTeam,
      text: `${nickname} mandou ${giftName} x${repeatCount} (+${boost}%)`,
      sound,
      gift: giftName,
      sender: nickname
    };
  }

  const flipped = checkLeader();
  if (flipped) {
    sound = 'virada';
    gameState.lastEvent = {
      type: 'virada',
      team: gameState.leader,
      text: `VIRADA! ${gameState[gameState.leader].name} NA FRENTE!`,
      sound: 'virada',
      sender: nickname
    };
  }

  const winner = checkWinner();
  if (winner) {
    gameState.lastEvent = {
      type: 'vitoria',
      team: winner,
      text: `${gameState[winner].name} VENCEU!`,
      sound: 'vitoria',
      sender: nickname
    };
  }

  io.emit('gameState', gameState);
  io.emit('playSound', sound);
  if (gameState.lastEvent) {
    io.emit('eventLog', gameState.lastEvent);
  }
  if (winner) {
    io.emit('vitoria', { team: winner, name: gameState[winner].name });
  }
}

io.on('connection', (socket) => {
  socket.emit('gameState', gameState);

  socket.on('connectTikTok', async ({ username }) => {
    try {
      if (tiktokConnection) {
        tiktokConnection.disconnect();
        tiktokConnection = null;
      }
      tiktokConnection = new WebcastPushConnection(username);
      await tiktokConnection.connect();
      io.emit('tiktokConnected', { username });
      io.emit('eventLog', { type: 'system', text: `Conectado @${username} - AUTOMATICO ATIVO!` });

      // LIKE = +0.1% per like
      tiktokConnection.on('like', (data) => {
        const totalLikes = data.totalLikeCount || 0;
        const likeCount = data.likeCount || 1;
        const target = totalLikes % 2 === 0 ? 'flamengo' : 'palmeiras';
        const boost = likeCount * 0.1;
        gameState[target].percent = Math.min(100, gameState[target].percent + boost);
        gameState[target].kmh = 70 + gameState[target].percent * 0.3;
        gameState.lastEvent = {
          type: 'like',
          team: target,
          text: `${data.nickname} enviou ${likeCount} curtidas (+${boost.toFixed(1)}%)`,
          sound: 'impulso30'
        };
        checkLeader();
        const winner = checkWinner();
        io.emit('gameState', gameState);
        if (winner) {
          io.emit('vitoria', { team: winner, name: gameState[winner].name });
          io.emit('eventLog', { type: 'vitoria', text: `${gameState[winner].name} VENCEU!` });
        } else {
          io.emit('eventLog', gameState.lastEvent);
        }
      });

      // CHAT = +1% se mencionar time
      tiktokConnection.on('chat', (data) => {
        const msg = (data.comment || '').toLowerCase();
        let team = null;
        if (msg.includes('fla') || msg.includes('mengo')) team = 'flamengo';
        if (msg.includes('palmeiras') || msg.includes('verdao') || msg.includes('porco')) team = 'palmeiras';
        if (team && !gameWinner) {
          gameState[team].percent = Math.min(100, gameState[team].percent + 1);
          gameState[team].kmh = 70 + gameState[team].percent * 0.3;
          gameState.lastEvent = {
            type: 'comment',
            team,
            text: `${data.nickname}: "${data.comment}" -> +1% ${gameState[team].name}`,
            sound: 'impulso30'
          };
          checkLeader();
          const winner = checkWinner();
          io.emit('gameState', gameState);
          if (winner) {
            io.emit('vitoria', { team: winner, name: gameState[winner].name });
            io.emit('eventLog', { type: 'vitoria', text: `${gameState[winner].name} VENCEU!` });
          } else {
            io.emit('eventLog', gameState.lastEvent);
          }
        }
      });

      // GIFT = impulso baseado no presente
      tiktokConnection.on('gift', (data) => {
        if (gameWinner) return;
        if (data.giftType === 1 && !data.repeatEnd) return;

        const giftName = (data.giftName || '').toLowerCase();
        const diamond = data.diamondCount || 0;
        const repeatCount = data.repeatCount || 1;
        let boost = 0;
        let sound = 'impulso30';
        let effect = null;

        if (giftName.includes('rosa') || giftName.includes('rose')) {
          boost = 30; sound = 'impulso30';
        } else if (giftName.includes('tiktok') || giftName.includes('tik tok')) {
          boost = 90; sound = 'impulso90';
        } else if (giftName.includes('capivara') || giftName.includes('leao') || giftName.includes('lion')) {
          boost = 150; sound = 'meta'; effect = 'fogo';
        } else if (giftName.includes('tropeco') || giftName.includes('banana') || giftName.includes('slip')) {
          boost = -15; sound = 'tropeco'; effect = 'tropeco';
        } else if (giftName.includes('escorregao') || giftName.includes('escorrega')) {
          boost = -20; sound = 'escorregao'; effect = 'escorregao';
        } else if (diamond >= 100) {
          boost = 150; sound = 'meta'; effect = 'fogo';
        } else if (diamond >= 10) {
          boost = 90; sound = 'impulso90';
        } else if (diamond >= 1) {
          boost = 30; sound = 'impulso30';
        } else {
          boost = 5;
        }

        applyBoost(null, boost, sound, effect, data.nickname || 'Alguem', data.giftName || 'presente', repeatCount);
      });

    } catch (err) {
      socket.emit('tiktokError', { message: err.message });
      io.emit('eventLog', { type: 'error', text: `Erro: ${err.message}` });
    }
  });

  socket.on('disconnectTikTok', () => {
    if (tiktokConnection) {
      tiktokConnection.disconnect();
      tiktokConnection = null;
      io.emit('tiktokDisconnected', {});
      io.emit('eventLog', { type: 'system', text: 'Desconectado da live.' });
    }
  });

  socket.on('reset', ({ teamA, teamB }) => {
    resetGame(teamA, teamB);
    io.emit('gameState', gameState);
    io.emit('eventLog', { type: 'system', text: `Nova corrida: ${teamA || 'FLAMENGO'} x ${teamB || 'PALMEIRAS'}` });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Corrida de Times rodando na porta ${PORT}`));
