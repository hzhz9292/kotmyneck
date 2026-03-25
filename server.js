const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const CONFIG = {
  width: 1000,
  height: 600,
  malletRadius: 55,
  puckRadius: 24,
  goalSize: 200,
  friction: 0.998,
  bounce: 0.98,
  maxSpeed: 900
};

let waiting = null;
const games = new Map();

function createGame(id, p1, p2) {
  return {
    id,
    players: {
      left: { id: p1.id, x: 200, y: 300, vx:0, vy:0, cheat:false },
      right: { id: p2.id, x: 800, y: 300, vx:0, vy:0, cheat:false }
    },
    puck: {
      x: 500,
      y: 300,
      vx: (Math.random() > 0.5 ? 1 : -1) * 400,
      vy: (Math.random() - 0.5) * 300
    },
    score: { left: 0, right: 0 }
  };
}

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

function collide(puck, p){
  const dx=puck.x-p.x;
  const dy=puck.y-p.y;
  const dist=Math.hypot(dx,dy);
  const min=CONFIG.malletRadius+CONFIG.puckRadius;

  if(dist>=min) return;

  const nx=dx/dist||1;
  const ny=dy/dist||0;

  puck.x=p.x+nx*min;
  puck.y=p.y+ny*min;

  const dot=puck.vx*nx+puck.vy*ny;

  puck.vx-=2*dot*nx;
  puck.vy-=2*dot*ny;

  puck.vx+=p.vx*(p.cheat?2:1);
  puck.vy+=p.vy*(p.cheat?2:1);
}

function step(g,dt){
  const p=g.puck;

  p.x+=p.vx*dt;
  p.y+=p.vy*dt;

  p.vx*=CONFIG.friction;
  p.vy*=CONFIG.friction;

  const speed=Math.hypot(p.vx,p.vy);
  if(speed>CONFIG.maxSpeed){
    p.vx=p.vx/speed*CONFIG.maxSpeed;
    p.vy=p.vy/speed*CONFIG.maxSpeed;
  }

  if(p.y<CONFIG.puckRadius||p.y>CONFIG.height-CONFIG.puckRadius){
    p.vy*=-CONFIG.bounce;
  }

  const gt=CONFIG.height/2-CONFIG.goalSize/2;
  const gb=CONFIG.height/2+CONFIG.goalSize/2;

  if(p.x<CONFIG.puckRadius){
    if(p.y>gt&&p.y<gb&&!g.players.left.cheat){
      g.score.right++; reset(g);
    } else p.vx*=-CONFIG.bounce;
  }

  if(p.x>CONFIG.width-CONFIG.puckRadius){
    if(p.y>gt&&p.y<gb&&!g.players.right.cheat){
      g.score.left++; reset(g);
    } else p.vx*=-CONFIG.bounce;
  }

  collide(p,g.players.left);
  collide(p,g.players.right);
}

function reset(g){
  g.puck.x=500;
  g.puck.y=300;
  g.puck.vx=(Math.random()>0.5?1:-1)*400;
  g.puck.vy=(Math.random()-0.5)*300;
}

setInterval(()=>{
  games.forEach(g=>{
    step(g,1/60);
    io.to(g.id).emit('state',g);
  });
},1000/60);

io.on('connection',socket=>{

  socket.on('find',()=>{
    if(waiting && waiting.id!==socket.id){
      const id=Date.now().toString();
      const g=createGame(id,waiting,socket);

      games.set(id,g);

      socket.join(id);
      waiting.join(id);

      socket.emit('start',{side:'right'});
      waiting.emit('start',{side:'left'});

      waiting=null;
    } else {
      waiting=socket;
    }
  });

  socket.on('move',({x,y})=>{
    games.forEach(g=>{
      const p =
        g.players.left.id===socket.id ? g.players.left :
        g.players.right.id===socket.id ? g.players.right : null;

      if(!p) return;

      const prevX=p.x;
      const prevY=p.y;

      if(!p.cheat){
        if(p===g.players.left) x=Math.min(x,500);
        else x=Math.max(x,500);
      }

      p.x=x;
      p.y=y;

      p.vx=(p.x-prevX)*60;
      p.vy=(p.y-prevY)*60;
    });
  });

  socket.on('cheat',(pass)=>{
    if(pass==="1230"){
      games.forEach(g=>{
        const p =
          g.players.left.id===socket.id ? g.players.left :
          g.players.right.id===socket.id ? g.players.right : null;
        if(p) p.cheat=true;
      });
    }
  });

});

server.listen(PORT,()=>console.log("RUN"));
