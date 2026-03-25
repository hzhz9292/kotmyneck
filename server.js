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
  goalHeight: 210,
  malletRadius: 48,
  puckRadius: 22,
  maxScore: 5,

  tickRate: 1000 / 60,
  resetDelayMs: 850,

  puckFrictionPerFrame: 0.996,
  wallBounce: 0.98,
  maxPuckSpeed: 1220,
  serveSpeedMin: 560,
  serveSpeedMax: 760
};

let waitingPlayer = null;
const matches = new Map();
const socketToMatch = new Map();

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function len(x, y) {
  return Math.hypot(x, y);
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function makeMallet(side) {
  const x = side === 'left' ? CONFIG.width * 0.24 : CONFIG.width * 0.76;
  const y = CONFIG.height * 0.5;
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    lastX: x,
    lastY: y,
    lastMoveAt: Date.now()
  };
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
        connected: true
      },
      right: {
        id: rightSocket.id,
        side: 'right',
        mallet: makeMallet('right'),
        character: 'Коржик',
        connected: true
      }
    },
    puck: {
      x: CONFIG.width / 2,
      y: CONFIG.height / 2,
      vx: 0,
      vy: 0,
      r: CONFIG.puckRadius
    },
    score: { left: 0, right: 0 },
    status: 'countdown',
    winner: null,
    goalMessage: '',
    roundEndsAt: Date.now() + 700,
    lastTick: Date.now(),
    interval: null
  };
}

function resetMallets(state) {
  state.players.left.mallet = makeMallet('left');
  state.players.right.mallet = makeMallet('right');
}

function resetPuck(state, towardSide = null) {
  state.puck.x = CONFIG.width / 2;
  state.puck.y = CONFIG.height / 2 + rand(-30, 30);

  const dir =
    towardSide === 'left'
      ? -1
      : towardSide === 'right'
      ? 1
      : Math.random() > 0.5
      ? 1
      : -1;

  const speed = rand(CONFIG.serveSpeedMin, CONFIG.serveSpeedMax);
  state.puck.vx = dir * speed;
  state.puck.vy = rand(-speed * 0.65, speed * 0.65);
}

function leaveWaiting(socket) {
  if (waitingPlayer && waitingPlayer.id === socket.id) {
    waitingPlayer = null;
  }
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
          vx: state.players.left.mallet.vx,
          vy: state.players.left.mallet.vy,
          character: state.players.left.character,
          connected: state.players.left.connected
        },
        right: {
          id: state.players.right.id,
          side: 'right',
          x: state.players.right.mallet.x,
          y: state.players.right.mallet.y,
          vx: state.players.right.mallet.vx,
          vy: state.players.right.mallet.vy,
          character: state.players.right.character,
          connected: state.players.right.connected
        }
      },
      puck: {
        x: state.puck.x,
        y: state.puck.y,
        vx: state.puck.vx,
        vy: state.puck.vy
      },
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
  resetMallets(state);
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

function collideMalletWithPuck(mallet, puck, boost = 1) {
  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const dist = len(dx, dy);
  const minDist = CONFIG.puckRadius + CONFIG.malletRadius;

  if (dist <= 0.0001 || dist >= minDist) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  puck.x += nx * overlap;
  puck.y += ny * overlap;

  const relVx = puck.vx - mallet.vx;
  const relVy = puck.vy - mallet.vy;
  const sepSpeed = relVx * nx + relVy * ny;

  if (sepSpeed < 0) {
    puck.vx -= 1.82 * sepSpeed * nx;
    puck.vy -= 1.82 * sepSpeed * ny;
  }

  const impact = Math.min(900, len(mallet.vx, mallet.vy)) * 0.38 * boost;
  puck.vx += nx * impact;
  puck.vy += ny * impact;

  const speed = len(puck.vx, puck.vy);
  if (speed > CONFIG.maxPuckSpeed) {
    puck.vx = (puck.vx / speed) * CONFIG.maxPuckSpeed;
    puck.vy = (puck.vy / speed) * CONFIG.maxPuckSpeed;
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
    state.goalMessage =
      scorerSide === 'left'
        ? 'Левый игрок победил!'
        : 'Правый игрок победил!';

    clearInterval(state.interval);
    state.interval = null;
    emitState(state, { final: true });
    return;
  }

  setTimeout(() => {
    if (!matches.has(state.roomId)) return;
    resetMallets(state);
    resetPuck(state, scorerSide === 'left' ? 'right' : 'left');
    state.status = 'playing';
    state.goalMessage = '';
  }, CONFIG.resetDelayMs);
}

function stepState(state, dt) {
  if (state.status !== 'playing') return;

  const puck = state.puck;

  puck.x += puck.vx * dt;
  puck.y += puck.vy * dt;

  puck.vx *= Math.pow(CONFIG.puckFrictionPerFrame, dt * 60);
  puck.vy *= Math.pow(CONFIG.puckFrictionPerFrame, dt * 60);

  const goalTop = CONFIG.height / 2 - CONFIG.goalHeight / 2;
  const goalBottom = CONFIG.height / 2 + CONFIG.goalHeight / 2;
  const inGoalMouth = puck.y > goalTop && puck.y < goalBottom;

  if (!inGoalMouth) {
    if (puck.x - CONFIG.puckRadius <= 0) {
      puck.x = CONFIG.puckRadius;
      puck.vx = Math.abs(puck.vx) * CONFIG.wallBounce;
    }
    if (puck.x + CONFIG.puckRadius >= CONFIG.width) {
      puck.x = CONFIG.width - CONFIG.puckRadius;
      puck.vx = -Math.abs(puck.vx) * CONFIG.wallBounce;
    }
  }

  if (puck.y - CONFIG.puckRadius <= 0) {
    puck.y = CONFIG.puckRadius;
    puck.vy = Math.abs(puck.vy) * CONFIG.wallBounce;
  }

  if (puck.y + CONFIG.puckRadius >= CONFIG.height) {
    puck.y = CONFIG.height - CONFIG.puckRadius;
    puck.vy = -Math.abs(puck.vy) * CONFIG.wallBounce;
  }

  collideMalletWithPuck(state.players.left.mallet, puck, 1.0);
  collideMalletWithPuck(state.players.right.mallet, puck, 1.0);

  if (puck.x + CONFIG.puckRadius < 0 && inGoalMouth) {
    goalScored(state, 'right');
    return;
  }

  if (puck.x - CONFIG.puckRadius > CONFIG.width && inGoalMouth) {
    goalScored(state, 'left');
    return;
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

      io.to(leftSocket.id).emit('matchFound', {
        side: 'left',
        roomId,
        opponent: state.players.right.character
      });

      io.to(rightSocket.id).emit('matchFound', {
        side: 'right',
        roomId,
        opponent: state.players.left.character
      });

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
    if (!state || state.status !== 'playing') return;

    const side =
      state.players.left.id === socket.id
        ? 'left'
        : state.players.right.id === socket.id
        ? 'right'
        : null;

    if (!side) return;

    const mallet = state.players[side].mallet;

    const minX =
      side === 'left'
        ? CONFIG.malletRadius + 8
        : CONFIG.width / 2 + CONFIG.malletRadius + 10;

    const maxX =
      side === 'left'
        ? CONFIG.width / 2 - CONFIG.malletRadius - 10
        : CONFIG.width - CONFIG.malletRadius - 8;

    const nx = clamp(Number(x) || 0, minX, maxX);
    const ny = clamp(
      Number(y) || 0,
      CONFIG.malletRadius + 8,
      CONFIG.height - CONFIG.malletRadius - 8
    );

    const now = Date.now();
    const dt = Math.max(0.001, Math.min(0.05, (now - mallet.lastMoveAt) / 1000));

    mallet.vx = (nx - mallet.x) / dt;
    mallet.vy = (ny - mallet.y) / dt;
    mallet.lastMoveAt = now;

    mallet.lastX = mallet.x;
    mallet.lastY = mallet.y;
    mallet.x = nx;
    mallet.y = ny;
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
