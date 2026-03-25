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
  width: 1200,
  height: 700,

  goalHeight: 230,

  malletRadius: 62,
  puckRadius: 28,

  maxScore: 5,

  tickRateMs: 1000 / 120,
  resetDelayMs: 900,

  friction: 0.997,
  wallBounce: 0.985,
  malletBounce: 1.04,

  serveSpeedMin: 620,
  serveSpeedMax: 820,
  maxPuckSpeed: 1250,
  minPuckSpeed: 120,

  collisionSubsteps: 5
};

let waitingSocket = null;
const matches = new Map();
const socketToRoom = new Map();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function len(x, y) {
  return Math.hypot(x, y);
}

function norm(x, y) {
  const d = Math.hypot(x, y) || 1;
  return { x: x / d, y: y / d };
}

function makeMallet(side) {
  const x = side === 'left' ? CONFIG.width * 0.22 : CONFIG.width * 0.78;
  const y = CONFIG.height * 0.5;
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    lastInputAt: Date.now()
  };
}

function createMatch(roomId, leftSocket, rightSocket) {
  return {
    roomId,
    sockets: {
      left: leftSocket,
      right: rightSocket
    },
    players: {
      left: {
        id: leftSocket.id,
        side: 'left',
        connected: true,
        character: leftSocket.data.character || 'Гоня',
        mallet: makeMallet('left')
      },
      right: {
        id: rightSocket.id,
        side: 'right',
        connected: true,
        character: rightSocket.data.character || 'Коржик',
        mallet: makeMallet('right')
      }
    },
    puck: {
      x: CONFIG.width / 2,
      y: CONFIG.height / 2,
      vx: 0,
      vy: 0
    },
    score: {
      left: 0,
      right: 0
    },
    status: 'starting',
    winner: null,
    goalMessage: '',
    lastTickAt: Date.now(),
    interval: null
  };
}

function leaveQueue(socket) {
  if (waitingSocket && waitingSocket.id === socket.id) {
    waitingSocket = null;
  }
}

function resetMallets(match) {
  match.players.left.mallet = makeMallet('left');
  match.players.right.mallet = makeMallet('right');
}

function resetPuck(match, towardSide = null) {
  match.puck.x = CONFIG.width / 2;
  match.puck.y = CONFIG.height / 2 + rand(-30, 30);

  const dir =
    towardSide === 'left'
      ? -1
      : towardSide === 'right'
      ? 1
      : Math.random() > 0.5
        ? 1
        : -1;

  const speed = rand(CONFIG.serveSpeedMin, CONFIG.serveSpeedMax);
  match.puck.vx = dir * speed;
  match.puck.vy = rand(-speed * 0.45, speed * 0.45);
}

function serializeMatch(match) {
  return {
    config: CONFIG,
    state: {
      players: {
        left: {
          id: match.players.left.id,
          side: 'left',
          x: match.players.left.mallet.x,
          y: match.players.left.mallet.y,
          vx: match.players.left.mallet.vx,
          vy: match.players.left.mallet.vy,
          character: match.players.left.character,
          connected: match.players.left.connected
        },
        right: {
          id: match.players.right.id,
          side: 'right',
          x: match.players.right.mallet.x,
          y: match.players.right.mallet.y,
          vx: match.players.right.mallet.vx,
          vy: match.players.right.mallet.vy,
          character: match.players.right.character,
          connected: match.players.right.connected
        }
      },
      puck: {
        x: match.puck.x,
        y: match.puck.y,
        vx: match.puck.vx,
        vy: match.puck.vy
      },
      score: {
        left: match.score.left,
        right: match.score.right
      },
      status: match.status,
      winner: match.winner,
      goalMessage: match.goalMessage,
      roomId: match.roomId
    }
  };
}

function emitMatch(match, extra = {}) {
  io.to(match.roomId).emit('state', {
    ...serializeMatch(match),
    ...extra
  });
}

function constrainMalletToSide(mallet, side) {
  const minX =
    side === 'left'
      ? CONFIG.malletRadius + 10
      : CONFIG.width / 2 + CONFIG.malletRadius + 10;

  const maxX =
    side === 'left'
      ? CONFIG.width / 2 - CONFIG.malletRadius - 10
      : CONFIG.width - CONFIG.malletRadius - 10;

  mallet.x = clamp(mallet.x, minX, maxX);
  mallet.y = clamp(mallet.y, CONFIG.malletRadius + 10, CONFIG.height - CONFIG.malletRadius - 10);
}

function moveMalletFromInput(mallet, side, nextX, nextY) {
  const now = Date.now();
  const dt = Math.max(0.001, Math.min(0.05, (now - mallet.lastInputAt) / 1000));

  const prevX = mallet.x;
  const prevY = mallet.y;

  mallet.x = nextX;
  mallet.y = nextY;
  constrainMalletToSide(mallet, side);

  mallet.vx = (mallet.x - prevX) / dt;
  mallet.vy = (mallet.y - prevY) / dt;
  mallet.lastInputAt = now;
}

function decayMalletVelocity(mallet) {
  mallet.vx *= 0.70;
  mallet.vy *= 0.70;
  if (Math.abs(mallet.vx) < 2) mallet.vx = 0;
  if (Math.abs(mallet.vy) < 2) mallet.vy = 0;
}

function resolveMalletPuckCollision(mallet, puck) {
  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = CONFIG.malletRadius + CONFIG.puckRadius;

  if (distance >= minDistance) return false;

  const n = distance === 0 ? { x: 1, y: 0 } : { x: dx / distance, y: dy / distance };
  const overlap = minDistance - distance;

  puck.x += n.x * overlap;
  puck.y += n.y * overlap;

  const relVx = puck.vx - mallet.vx;
  const relVy = puck.vy - mallet.vy;
  const relNormal = relVx * n.x + relVy * n.y;

  if (relNormal < 0) {
    puck.vx -= 1.92 * relNormal * n.x;
    puck.vy -= 1.92 * relNormal * n.y;
  }

  puck.vx += mallet.vx * 0.34 * CONFIG.malletBounce;
  puck.vy += mallet.vy * 0.34 * CONFIG.malletBounce;

  const currentSpeed = len(puck.vx, puck.vy);
  if (currentSpeed > CONFIG.maxPuckSpeed) {
    puck.vx = (puck.vx / currentSpeed) * CONFIG.maxPuckSpeed;
    puck.vy = (puck.vy / currentSpeed) * CONFIG.maxPuckSpeed;
  }

  return true;
}

function handleWallsAndGoals(match) {
  const puck = match.puck;
  const goalTop = CONFIG.height / 2 - CONFIG.goalHeight / 2;
  const goalBottom = CONFIG.height / 2 + CONFIG.goalHeight / 2;
  const insideGoal = puck.y > goalTop && puck.y < goalBottom;

  if (puck.y - CONFIG.puckRadius <= 0) {
    puck.y = CONFIG.puckRadius;
    puck.vy = Math.abs(puck.vy) * CONFIG.wallBounce;
  }

  if (puck.y + CONFIG.puckRadius >= CONFIG.height) {
    puck.y = CONFIG.height - CONFIG.puckRadius;
    puck.vy = -Math.abs(puck.vy) * CONFIG.wallBounce;
  }

  if (!insideGoal) {
    if (puck.x - CONFIG.puckRadius <= 0) {
      puck.x = CONFIG.puckRadius;
      puck.vx = Math.abs(puck.vx) * CONFIG.wallBounce;
    }

    if (puck.x + CONFIG.puckRadius >= CONFIG.width) {
      puck.x = CONFIG.width - CONFIG.puckRadius;
      puck.vx = -Math.abs(puck.vx) * CONFIG.wallBounce;
    }
  }

  if (puck.x + CONFIG.puckRadius < 0 && insideGoal) {
    scoreGoal(match, 'right');
    return true;
  }

  if (puck.x - CONFIG.puckRadius > CONFIG.width && insideGoal) {
    scoreGoal(match, 'left');
    return true;
  }

  return false;
}

function scoreGoal(match, scorerSide) {
  match.score[scorerSide] += 1;
  match.goalMessage = scorerSide === 'left' ? 'Гол слева!' : 'Гол справа!';
  match.status = 'goal';
  match.puck.vx = 0;
  match.puck.vy = 0;

  if (match.score[scorerSide] >= CONFIG.maxScore) {
    match.status = 'finished';
    match.winner = scorerSide;
    match.goalMessage = scorerSide === 'left' ? 'Левый игрок победил!' : 'Правый игрок победил!';

    if (match.interval) {
      clearInterval(match.interval);
      match.interval = null;
    }

    emitMatch(match, { final: true });
    return;
  }

  setTimeout(() => {
    if (!matches.has(match.roomId)) return;
    resetMallets(match);
    resetPuck(match, scorerSide === 'left' ? 'right' : 'left');
    match.status = 'playing';
    match.goalMessage = '';
  }, CONFIG.resetDelayMs);
}

function stepMatch(match, dt) {
  if (match.status !== 'playing') return;

  decayMalletVelocity(match.players.left.mallet);
  decayMalletVelocity(match.players.right.mallet);

  const puck = match.puck;
  const subDt = dt / CONFIG.collisionSubsteps;

  for (let i = 0; i < CONFIG.collisionSubsteps; i += 1) {
    puck.x += puck.vx * subDt;
    puck.y += puck.vy * subDt;

    resolveMalletPuckCollision(match.players.left.mallet, puck);
    resolveMalletPuckCollision(match.players.right.mallet, puck);

    if (handleWallsAndGoals(match)) return;
  }

  puck.vx *= CONFIG.friction;
  puck.vy *= CONFIG.friction;

  const speed = len(puck.vx, puck.vy);

  if (speed > CONFIG.maxPuckSpeed) {
    puck.vx = (puck.vx / speed) * CONFIG.maxPuckSpeed;
    puck.vy = (puck.vy / speed) * CONFIG.maxPuckSpeed;
  } else if (speed > 0 && speed < CONFIG.minPuckSpeed) {
    puck.vx = (puck.vx / speed) * CONFIG.minPuckSpeed;
    puck.vy = (puck.vy / speed) * CONFIG.minPuckSpeed;
  }
}

function startMatchLoop(match) {
  resetMallets(match);
  resetPuck(match);
  match.status = 'playing';
  match.lastTickAt = Date.now();

  match.interval = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.02, (now - match.lastTickAt) / 1000);
    match.lastTickAt = now;

    stepMatch(match, dt);
    emitMatch(match);
  }, CONFIG.tickRateMs);
}

function cleanupMatch(roomId) {
  const match = matches.get(roomId);
  if (!match) return;

  if (match.interval) clearInterval(match.interval);

  socketToRoom.delete(match.players.left.id);
  socketToRoom.delete(match.players.right.id);
  matches.delete(roomId);
}

io.on('connection', (socket) => {
  socket.emit('welcome', { socketId: socket.id });

  socket.on('findMatch', ({ character }) => {
    leaveQueue(socket);
    socket.data.character = character || 'Гоня';

    if (waitingSocket && waitingSocket.id !== socket.id && waitingSocket.connected) {
      const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const leftSocket = waitingSocket;
      const rightSocket = socket;

      leftSocket.join(roomId);
      rightSocket.join(roomId);

      const match = createMatch(roomId, leftSocket, rightSocket);
      matches.set(roomId, match);
      socketToRoom.set(leftSocket.id, roomId);
      socketToRoom.set(rightSocket.id, roomId);

      waitingSocket = null;

      io.to(leftSocket.id).emit('matchFound', {
        side: 'left',
        roomId,
        opponent: match.players.right.character
      });

      io.to(rightSocket.id).emit('matchFound', {
        side: 'right',
        roomId,
        opponent: match.players.left.character
      });

      startMatchLoop(match);
    } else {
      waitingSocket = socket;
      socket.emit('queue', { message: 'Ищем соперника...' });
    }
  });

  socket.on('move', ({ x, y }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;

    const match = matches.get(roomId);
    if (!match || match.status !== 'playing') return;

    const side =
      match.players.left.id === socket.id
        ? 'left'
        : match.players.right.id === socket.id
          ? 'right'
          : null;

    if (!side) return;

    const mallet = match.players[side].mallet;
    const minX =
      side === 'left'
        ? CONFIG.malletRadius + 10
        : CONFIG.width / 2 + CONFIG.malletRadius + 10;

    const maxX =
      side === 'left'
        ? CONFIG.width / 2 - CONFIG.malletRadius - 10
        : CONFIG.width - CONFIG.malletRadius - 10;

    const nextX = clamp(Number(x) || 0, minX, maxX);
    const nextY = clamp(Number(y) || 0, CONFIG.malletRadius + 10, CONFIG.height - CONFIG.malletRadius - 10);

    moveMalletFromInput(mallet, side, nextX, nextY);
  });

  socket.on('disconnect', () => {
    leaveQueue(socket);

    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;

    const match = matches.get(roomId);
    if (!match) return;

    const side = match.players.left.id === socket.id ? 'left' : 'right';
    match.players[side].connected = false;

    const otherSide = side === 'left' ? 'right' : 'left';
    const otherSocket = match.sockets[otherSide];

    if (otherSocket && otherSocket.connected) {
      io.to(otherSocket.id).emit('opponentLeft');
    }

    cleanupMatch(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
