const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Rooms storage
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Create room
  socket.on('create_room', ({ username }) => {
    let code;
    do { code = generateCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [{ id: socket.id, username, role: 'host', team: [], budget: 1000, ready: false }],
      phase: 'lobby',
      draft: {
        mode: null,
        currentOffers: [],
        currentAuction: null,
        bids: {},
        assignments: {},
        picks: { host: [], client: [] }
      },
      battle: null
    };

    socket.join(code);
    socket.roomCode = code;
    socket.role = 'host';
    socket.emit('room_created', { code, role: 'host', username });
    console.log(`[Room] Created: ${code} by ${username}`);
  });

  // Join room
  socket.on('join_room', ({ code, username }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Salon introuvable.');
    if (room.players.length >= 2) return socket.emit('error', 'Salon complet.');
    if (room.phase !== 'lobby') return socket.emit('error', 'Partie déjà commencée.');

    room.players.push({ id: socket.id, username, role: 'client', team: [], budget: 1000, ready: false });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'client';

    const host = room.players[0];
    socket.emit('room_joined', { code, role: 'client', username, opponent: host.username });
    io.to(host.id).emit('opponent_joined', { username });
    io.to(code).emit('players_update', {
      players: room.players.map(p => ({ username: p.username, role: p.role, teamCount: p.team.length, budget: p.budget }))
    });
    console.log(`[Room] ${username} joined ${code}`);
  });

  // Host starts draft
  socket.on('start_draft', ({ mode }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.role !== 'host') return;
    if (room.players.length < 2) return socket.emit('error', 'En attente du second joueur.');

    room.phase = 'draft';
    room.draft.mode = mode;
    room.draft.picks = { host: [], client: [] };
    room.players.forEach(p => { p.team = []; p.budget = 1000; });

    io.to(socket.roomCode).emit('draft_started', { mode });
    console.log(`[Draft] Started in ${socket.roomCode} mode: ${mode}`);
  });

  // Host requests new set of 3 pokemon offers
  socket.on('request_offers', ({ pokemons }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.role !== 'host') return;

    room.draft.currentOffers = pokemons;

    // Host sees full data, client sees hints
    const host = room.players.find(p => p.role === 'host');
    const client = room.players.find(p => p.role === 'client');

    io.to(host.id).emit('offers_update', { pokemons, isHost: true, mode: room.draft.mode });
    io.to(client.id).emit('offers_update', { pokemons, isHost: false, mode: room.draft.mode });
  });

  // Standard pick (non-auction modes): host picks one of 3
  socket.on('pick_pokemon', ({ pokemon, pickerRole }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    const picker = room.players.find(p => p.role === pickerRole);
    if (!picker) return;

    picker.team.push(pokemon);
    room.draft.picks[pickerRole].push(pokemon);

    io.to(socket.roomCode).emit('pokemon_picked', {
      role: pickerRole,
      username: picker.username,
      pokemon,
      teamCount: picker.team.length
    });

    io.to(socket.roomCode).emit('players_update', {
      players: room.players.map(p => ({ username: p.username, role: p.role, teamCount: p.team.length, budget: p.budget }))
    });

    // Check if draft complete (both have 6)
    checkDraftComplete(room);
  });

  // Auction: start auction for a specific offer index
  socket.on('start_auction', ({ offerIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.role !== 'host') return;

    room.draft.currentAuction = {
      offerIndex,
      pokemon: room.draft.currentOffers[offerIndex],
      highestBid: 0,
      highestBidder: null,
      active: true
    };
    room.draft.bids = {};

    io.to(socket.roomCode).emit('auction_started', {
      offerIndex,
      pokemon: room.draft.currentOffers[offerIndex],
      players: room.players.map(p => ({ username: p.username, role: p.role, budget: p.budget }))
    });
  });

  // Bid
  socket.on('place_bid', ({ amount }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.draft.currentAuction || !room.draft.currentAuction.active) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const auction = room.draft.currentAuction;
    const newBid = auction.highestBid + amount;

    if (player.budget < newBid) return socket.emit('error', 'Budget insuffisant.');

    auction.highestBid = newBid;
    auction.highestBidder = player.role;

    io.to(socket.roomCode).emit('bid_update', {
      highestBid: newBid,
      highestBidder: player.username,
      highestBidderRole: player.role,
      players: room.players.map(p => ({ username: p.username, role: p.role, budget: p.budget }))
    });
  });

  // Host closes auction
  socket.on('close_auction', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.role !== 'host') return;

    const auction = room.draft.currentAuction;
    if (!auction || !auction.active) return;

    auction.active = false;
    const winner = room.players.find(p => p.role === auction.highestBidder);

    if (winner && auction.highestBid > 0) {
      winner.budget -= auction.highestBid;
      winner.team.push(auction.pokemon);
      room.draft.picks[winner.role].push(auction.pokemon);

      io.to(socket.roomCode).emit('auction_closed', {
        winner: winner.username,
        winnerRole: winner.role,
        pokemon: auction.pokemon,
        finalBid: auction.highestBid,
        players: room.players.map(p => ({ username: p.username, role: p.role, budget: p.budget, teamCount: p.team.length }))
      });
    } else {
      io.to(socket.roomCode).emit('auction_closed', {
        winner: null,
        pokemon: auction.pokemon,
        finalBid: 0,
        players: room.players.map(p => ({ username: p.username, role: p.role, budget: p.budget, teamCount: p.team.length }))
      });
    }

    checkDraftComplete(room);
  });

  // Battle: player sends action
  socket.on('battle_action', ({ action, moveIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'battle') return;

    const battle = room.battle;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    battle.pendingActions[player.role] = { action, moveIndex };

    // Both players have acted
    if (battle.pendingActions.host && battle.pendingActions.client) {
      resolveTurn(room, io);
    } else {
      socket.emit('waiting_for_opponent');
    }
  });

  // Switch pokemon
  socket.on('switch_pokemon', ({ index }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'battle') return;

    const battle = room.battle;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const side = player.role === 'host' ? battle.host : battle.client;
    if (index >= 0 && index < side.team.length && side.team[index].currentHp > 0) {
      side.activePokemonIndex = index;
      io.to(socket.roomCode).emit('battle_state', getBattleState(room));
    }
  });

  // Start battle (called after both teams ready)
  socket.on('init_battle', ({ hostTeam, clientTeam }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.role !== 'host') return;

    room.phase = 'battle';

    const prepareSide = (team) => team.map(p => ({
      ...p,
      currentHp: p.stats.hp * 5,
      maxHp: p.stats.hp * 5
    }));

    room.battle = {
      host: { team: prepareSide(hostTeam), activePokemonIndex: 0 },
      client: { team: prepareSide(clientTeam), activePokemonIndex: 0 },
      turn: 1,
      log: [],
      pendingActions: {},
      winner: null
    };

    io.to(socket.roomCode).emit('battle_started', getBattleState(room));
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('player_disconnected', { message: 'Votre adversaire s\'est déconnecté.' });
      // Clean up room after short delay
      setTimeout(() => { delete rooms[code]; }, 30000);
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

function checkDraftComplete(room) {
  const allHaveSix = room.players.every(p => p.team.length >= 6);
  if (allHaveSix) {
    room.phase = 'battle_ready';
    const host = room.players.find(p => p.role === 'host');
    const client = room.players.find(p => p.role === 'client');
    io.to(room.code).emit('draft_complete', {
      hostTeam: host.team,
      clientTeam: client.team
    });
  }
}

function getBattleState(room) {
  const b = room.battle;
  const hostActive = b.host.team[b.host.activePokemonIndex];
  const clientActive = b.client.team[b.client.activePokemonIndex];
  return {
    host: {
      activePokemon: hostActive,
      activePokemonIndex: b.host.activePokemonIndex,
      team: b.host.team.map(p => ({ name: p.name, currentHp: p.currentHp, maxHp: p.maxHp, sprite: p.sprite }))
    },
    client: {
      activePokemon: clientActive,
      activePokemonIndex: b.client.activePokemonIndex,
      team: b.client.team.map(p => ({ name: p.name, currentHp: p.currentHp, maxHp: p.maxHp, sprite: p.sprite }))
    },
    turn: b.turn,
    log: b.log.slice(-10),
    winner: b.winner
  };
}

function resolveTurn(room, io) {
  const b = room.battle;
  const hostPlayer = room.players.find(p => p.role === 'host');
  const clientPlayer = room.players.find(p => p.role === 'client');

  const hostSide = b.host;
  const clientSide = b.client;
  const hostActive = hostSide.team[hostSide.activePokemonIndex];
  const clientActive = clientSide.team[clientSide.activePokemonIndex];

  const hostAction = b.pendingActions.host;
  const clientAction = b.pendingActions.client;
  b.pendingActions = {};

  let logEntries = [];

  function calcDamage(attacker, defender, move) {
    if (!move || !move.power) return 0;
    const atk = attacker.stats.attack || 50;
    const def = defender.stats.defense || 50;
    const base = Math.floor(((2 * 50 / 5 + 2) * move.power * (atk / def)) / 50 + 2);
    const variance = 0.85 + Math.random() * 0.15;
    return Math.max(1, Math.floor(base * variance));
  }

  function applyAction(attackerSide, defenderSide, action, attackerName, defenderName) {
    if (action.action === 'move') {
      const attacker = attackerSide.team[attackerSide.activePokemonIndex];
      const defender = defenderSide.team[defenderSide.activePokemonIndex];
      const move = attacker.moves[action.moveIndex];
      if (!move) return;

      const dmg = calcDamage(attacker, defender, move);
      defender.currentHp = Math.max(0, defender.currentHp - dmg);

      if (dmg > 0) {
        logEntries.push(`${attackerName} utilise ${move.name} → ${dmg} dégâts sur ${defenderName} !`);
      } else {
        logEntries.push(`${attackerName} utilise ${move.name} → Pas d'effet...`);
      }

      // Check faint
      if (defender.currentHp === 0) {
        logEntries.push(`${defenderName} est K.O. !`);
        // Auto switch to next alive
        const nextIndex = defenderSide.team.findIndex((p, i) => i > defenderSide.activePokemonIndex && p.currentHp > 0);
        if (nextIndex !== -1) defenderSide.activePokemonIndex = nextIndex;
        else {
          const anyAlive = defenderSide.team.findIndex(p => p.currentHp > 0);
          if (anyAlive !== -1) defenderSide.activePokemonIndex = anyAlive;
        }
      }
    }
  }

  // Determine order by speed
  const hostSpeed = hostActive.stats.speed || 50;
  const clientSpeed = clientActive.stats.speed || 50;

  if (hostSpeed >= clientSpeed) {
    applyAction(hostSide, clientSide, hostAction, hostPlayer.username, clientPlayer.username);
    if (clientActive.currentHp > 0) {
      applyAction(clientSide, hostSide, clientAction, clientPlayer.username, hostPlayer.username);
    }
  } else {
    applyAction(clientSide, hostSide, clientAction, clientPlayer.username, hostPlayer.username);
    if (hostActive.currentHp > 0) {
      applyAction(hostSide, clientSide, hostAction, hostPlayer.username, clientPlayer.username);
    }
  }

  b.log.push(...logEntries);
  b.turn++;

  // Check win condition
  const hostAlive = hostSide.team.some(p => p.currentHp > 0);
  const clientAlive = clientSide.team.some(p => p.currentHp > 0);

  if (!hostAlive) b.winner = clientPlayer.username;
  else if (!clientAlive) b.winner = hostPlayer.username;

  io.to(room.code).emit('battle_state', getBattleState(room));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Pokémon Blind Pick server running on http://localhost:${PORT}\n`);
});