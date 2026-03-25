
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const CONFIG = {
  width: 1280,
  height: 720,
  goalHeight: 180,
  malletRadius: 34,
  puckRadius: 20,
  maxScore: 5,
  playerSpeed: 920,
  puckFriction: 0.996,
  puckBounce: 0.992,
  malletBounce: 1.02,
  tickRate: 1000 / 60,
  resetDelayMs: 1200,
  startPuckSpeed: 280,
};

let waitingPlayer = null;
const matches = new Map();
const socketToMatch = new Map();

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function makeMallet(side) {
  const x = side === 'left' ? CONFIG.width * 0.18 : CONFIG.width * 0.82;
  return { x, y: CONFIG.height / 2, targetX: x, targetY: CONFIG.height / 2 };
}

function createState(roomId, leftSocket, rightSocket) {
  return {
    roomId,
    sockets: { left: leftSocket, right: rightSocket },
    players: {
      left: {
        id: leftSocket.id,
        side: 'left',
        mallet: makeMallet('left'),
        character: 'Гоня',
        connected: true,
      },
      right: {
        id: rightSocket.id,
        side: 'right',
        mallet: makeMallet('right'),
        character: 'Коржик',
        connected: true,
      }
    },
    puck: {
      x: CONFIG.width / 2,
      y: CONFIG.height / 2,
      vx: 0,
      vy: 0
    },
    score: { left: 0, right: 0 },
    status: 'countdown',
    winner: null,
    goalMessage: '',
    roundEndsAt: Date.now() + 700,
    lastTick: Date.now(),
    interval: null,
  };
}

function resetPuck(state, towardSide = null) {
  state.puck.x = CONFIG.width / 2;
  state.puck.y = CONFIG.height / 2 + rand(-40, 40);
  const dir = towardSide === 'left' ? -1 : towardSide === 'right' ? 1 : (Math.random() > 0.5 ? 1 : -1);
  state.puck.vx = dir * rand(CONFIG.startPuckSpeed * 0.7, CONFIG.startPuckSpeed);
  state.puck.vy = rand(-CONFIG.startPuckSpeed * 0.8, CONFIG.startPuckSpeed * 0.8);
}

function leaveWaiting(socket) {
  if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
}

function emitState(state, extra = {}) {
  const payload = {
    config: CONFIG,
    state: {
      players: {
        left: {
          id: state.players.left.id,
          side: 'left',
          x: state.players.left.mallet.x,
          y: state.players.left.mallet.y,
          character: state.players.left.character,
          connected: state.players.left.connected
        },
        right: {
          id: state.players.right.id,
          side: 'right',
          x: state.players.right.mallet.x,
          y: state.players.right.mallet.y,
          character: state.players.right.character,
          connected: state.players.right.connected
        }
      },
      puck: state.puck,
      score: state.score,
      status: state.status,
      winner: state.winner,
      goalMessage: state.goalMessage,
      roomId: state.roomId,
      roundEndsAt: state.roundEndsAt
    },
    ...extra
  };
  io.to(state.roomId).emit('state', payload);
}

function startMatch(state) {
  resetPuck(state);
  state.status = 'playing';
  state.lastTick = Date.now();

  state.interval = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.033, (now - state.lastTick) / 1000);
    state.lastTick = now;
    stepState(state, dt);
    emitState(state);
  }, CONFIG.tickRate);
}

function stepMallet(player, dt) {
  const m = player.mallet;
  const dx = m.targetX - m.x;
  const dy = m.targetY - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return;
  const maxMove = CONFIG.playerSpeed * dt;
  const move = Math.min(maxMove, dist);
  m.x += dx / dist * move;
  m.y += dy / dist * move;

  const minX = player.side === 'left' ? CONFIG.malletRadius + 12 : CONFIG.width / 2 + CONFIG.malletRadius + 8;
  const maxX = player.side === 'left' ? CONFIG.width / 2 - CONFIG.malletRadius - 8 : CONFIG.width - CONFIG.malletRadius - 12;
  m.x = clamp(m.x, minX, maxX);
  m.y = clamp(m.y, CONFIG.malletRadius + 12, CONFIG.height - CONFIG.malletRadius - 12);
}

function collideMalletWithPuck(player, puck) {
  const m = player.mallet;
  const dx = puck.x - m.x;
  const dy = puck.y - m.y;
  const dist = Math.hypot(dx, dy);
  const minDist = CONFIG.malletRadius + CONFIG.puckRadius;
  if (dist === 0 || dist >= minDist) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;
  puck.x += nx * overlap;
  puck.y += ny * overlap;

  const malletVx = (m.targetX - m.x) * 0.03;
  const malletVy = (m.targetY - m.y) * 0.03;
  const relVx = puck.vx - malletVx;
  const relVy = puck.vy - malletVy;
  const speedAlongNormal = relVx * nx + relVy * ny;

  if (speedAlongNormal < 0) {
    puck.vx -= (1.95 * speedAlongNormal) * nx;
    puck.vy -= (1.95 * speedAlongNormal) * ny;
  }

  puck.vx += malletVx * CONFIG.malletBounce;
  puck.vy += malletVy * CONFIG.malletBounce;

  const speed = Math.hypot(puck.vx, puck.vy);
  const maxSpeed = 1450;
  if (speed > maxSpeed) {
    puck.vx = puck.vx / speed * maxSpeed;
    puck.vy = puck.vy / speed * maxSpeed;
  }
}

function goalScored(state, scorerSide) {
  state.score[scorerSide] += 1;
  state.goalMessage = scorerSide === 'left' ? 'Гол слева!' : 'Гол справа!';
  state.status = 'goal';
  state.roundEndsAt = Date.now() + CONFIG.resetDelayMs;
  state.puck.vx = 0;
  state.puck.vy = 0;

  if (state.score[scorerSide] >= CONFIG.maxScore) {
    state.status = 'finished';
    state.winner = scorerSide;
    state.goalMessage = scorerSide === 'left' ? 'Левый игрок победил!' : 'Правый игрок победил!';
    clearInterval(state.interval);
    state.interval = null;
    emitState(state, { final: true });
    return;
  }

  setTimeout(() => {
    if (!matches.has(state.roomId)) return;
    state.players.left.mallet = makeMallet('left');
    state.players.right.mallet = makeMallet('right');
    resetPuck(state, scorerSide === 'left' ? 'right' : 'left');
    state.status = 'playing';
    state.goalMessage = '';
  }, CONFIG.resetDelayMs);
}

function stepState(state, dt) {
  if (state.status !== 'playing') return;

  stepMallet(state.players.left, dt);
  stepMallet(state.players.right, dt);

  state.puck.x += state.puck.vx * dt;
  state.puck.y += state.puck.vy * dt;
  state.puck.vx *= CONFIG.puckFriction;
  state.puck.vy *= CONFIG.puckFriction;

  const goalTop = CONFIG.height / 2 - CONFIG.goalHeight / 2;
  const goalBottom = CONFIG.height / 2 + CONFIG.goalHeight / 2;

  if (state.puck.y - CONFIG.puckRadius <= 0) {
    state.puck.y = CONFIG.puckRadius;
    state.puck.vy *= -CONFIG.puckBounce;
  }
  if (state.puck.y + CONFIG.puckRadius >= CONFIG.height) {
    state.puck.y = CONFIG.height - CONFIG.puckRadius;
    state.puck.vy *= -CONFIG.puckBounce;
  }

  const inGoalWindow = state.puck.y > goalTop && state.puck.y < goalBottom;

  if (!inGoalWindow) {
    if (state.puck.x - CONFIG.puckRadius <= 0) {
      state.puck.x = CONFIG.puckRadius;
      state.puck.vx *= -CONFIG.puckBounce;
    }
    if (state.puck.x + CONFIG.puckRadius >= CONFIG.width) {
      state.puck.x = CONFIG.width - CONFIG.puckRadius;
      state.puck.vx *= -CONFIG.puckBounce;
    }
  }

  collideMalletWithPuck(state.players.left, state.puck);
  collideMalletWithPuck(state.players.right, state.puck);

  if (state.puck.x + CONFIG.puckRadius < 0 && inGoalWindow) {
    goalScored(state, 'right');
  } else if (state.puck.x - CONFIG.puckRadius > CONFIG.width && inGoalWindow) {
    goalScored(state, 'left');
  }
}

function cleanupMatch(roomId) {
  const state = matches.get(roomId);
  if (!state) return;
  if (state.interval) clearInterval(state.interval);
  matches.delete(roomId);
}

io.on('connection', (socket) => {
  socket.emit('welcome', { socketId: socket.id });

  socket.on('findMatch', ({ character }) => {
    leaveWaiting(socket);
    socket.data.character = character || 'Гоня';

    if (waitingPlayer && waitingPlayer.id !== socket.id && waitingPlayer.connected) {
      const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const leftSocket = waitingPlayer;
      const rightSocket = socket;

      leftSocket.join(roomId);
      rightSocket.join(roomId);

      const state = createState(roomId, leftSocket, rightSocket);
      state.players.left.character = leftSocket.data.character || 'Гоня';
      state.players.right.character = rightSocket.data.character || 'Коржик';

      matches.set(roomId, state);
      socketToMatch.set(leftSocket.id, roomId);
      socketToMatch.set(rightSocket.id, roomId);
      waitingPlayer = null;

      io.to(leftSocket.id).emit('matchFound', { side: 'left', roomId, opponent: state.players.right.character });
      io.to(rightSocket.id).emit('matchFound', { side: 'right', roomId, opponent: state.players.left.character });

      startMatch(state);
    } else {
      waitingPlayer = socket;
      socket.emit('queue', { message: 'Ищем соперника...' });
    }
  });

  socket.on('move', ({ x, y }) => {
    const roomId = socketToMatch.get(socket.id);
    if (!roomId) return;
    const state = matches.get(roomId);
    if (!state) return;

    const side = state.players.left.id === socket.id ? 'left' : state.players.right.id === socket.id ? 'right' : null;
    if (!side) return;
    const player = state.players[side];

    const minX = side === 'left' ? CONFIG.malletRadius + 12 : CONFIG.width / 2 + CONFIG.malletRadius + 8;
    const maxX = side === 'left' ? CONFIG.width / 2 - CONFIG.malletRadius - 8 : CONFIG.width - CONFIG.malletRadius - 12;
    player.mallet.targetX = clamp(Number(x) || 0, minX, maxX);
    player.mallet.targetY = clamp(Number(y) || 0, CONFIG.malletRadius + 12, CONFIG.height - CONFIG.malletRadius - 12);
  });

  socket.on('rematch', () => {
    // For simple version just re-queue immediately
    const roomId = socketToMatch.get(socket.id);
    if (roomId) {
      const state = matches.get(roomId);
      if (state) {
        const otherId = state.players.left.id === socket.id ? state.players.right.id : state.players.left.id;
        const other = io.sockets.sockets.get(otherId);
        cleanupMatch(roomId);
        socketToMatch.delete(socket.id);
        socketToMatch.delete(otherId);
        if (other && other.connected) {
          other.emit('queue', { message: 'Соперник ищет новый матч...' });
          waitingPlayer = other;
        }
      }
    }
    socket.emit('queue', { message: 'Ищем соперника...' });
    if (waitingPlayer && waitingPlayer.id !== socket.id && waitingPlayer.connected) {
      const queued = waitingPlayer;
      waitingPlayer = null;
      socket.emit('findMatchReplay');
      queued.emit('findMatchReplay');
    } else {
      waitingPlayer = socket;
    }
  });

  socket.on('disconnect', () => {
    leaveWaiting(socket);
    const roomId = socketToMatch.get(socket.id);
    if (!roomId) return;

    const state = matches.get(roomId);
    if (!state) return;

    const side = state.players.left.id === socket.id ? 'left' : 'right';
    state.players[side].connected = false;
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherSocket = state.sockets[otherSide];

    if (otherSocket && otherSocket.connected) {
      io.to(otherSocket.id).emit('opponentLeft');
    }

    socketToMatch.delete(state.players.left.id);
    socketToMatch.delete(state.players.right.id);
    cleanupMatch(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
