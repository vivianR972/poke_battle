/* ═══════════════════════════════════════════════
   POKÉMON BLIND PICK — script.js
   Logique client : Lobby, Draft, Enchères, Combat
═══════════════════════════════════════════════ */

const socket = io();

/* ──────────────────────────────────────────────
   STATE
────────────────────────────────────────────── */
const state = {
  username: '',
  role: null,          // 'host' | 'client'
  roomCode: null,
  opponent: '',
  draftMode: null,
  myTeam: [],
  oppTeam: [],
  myBudget: 1000,
  oppBudget: 1000,
  currentOffers: [],   // [{id, name, sprite, spriteBack, types, height, weight, color, hp, generation, moves, stats}]
  auctionActive: false,
  myPendingAction: false,
};

/* ──────────────────────────────────────────────
   POKÉAPI HELPERS
────────────────────────────────────────────── */
const POKE_API = 'https://pokeapi.co/api/v2';
const TOTAL_POKEMON = 1008; // Gen 1-9

const GENERATION_MAP = [
  { max: 151,  label: 'Génération 1 (Kanto)' },
  { max: 251,  label: 'Génération 2 (Johto)' },
  { max: 386,  label: 'Génération 3 (Hoenn)' },
  { max: 493,  label: 'Génération 4 (Sinnoh)' },
  { max: 649,  label: 'Génération 5 (Unova)' },
  { max: 721,  label: 'Génération 6 (Kalos)' },
  { max: 809,  label: 'Génération 7 (Alola)' },
  { max: 905,  label: 'Génération 8 (Galar)' },
  { max: 1008, label: 'Génération 9 (Paldea)' },
];

function getGeneration(id) {
  for (const g of GENERATION_MAP) {
    if (id <= g.max) return g.label;
  }
  return 'Génération inconnue';
}

async function fetchPokemon(id) {
  const [pData, sData] = await Promise.all([
    fetch(`${POKE_API}/pokemon/${id}`).then(r => r.json()),
    fetch(`${POKE_API}/pokemon-species/${id}`).then(r => r.json()),
  ]);

  const color = sData.color ? sData.color.name : '?';

  // Pick up to 4 random moves with power
  const movesWithPower = pData.moves
    .map(m => ({ name: m.move.name, url: m.move.url }))
    .filter(() => true); // all moves

  // We'll fetch move details for a random sample to find 4 with power
  const shuffled = movesWithPower.sort(() => Math.random() - 0.5).slice(0, 20);
  const moveDetails = await Promise.all(
    shuffled.map(m => fetch(m.url).then(r => r.json()).catch(() => null))
  );
  const validMoves = moveDetails
    .filter(m => m && m.power && m.power > 0)
    .slice(0, 4)
    .map(m => ({ name: m.name, power: m.power, type: m.type?.name || 'normal' }));

  // Fallback if no moves found
  while (validMoves.length < 4) {
    validMoves.push({ name: 'Charge', power: 40, type: 'normal' });
  }

  const stats = {};
  pData.stats.forEach(s => {
    const key = s.stat.name.replace('-', '_');
    stats[key] = s.base_stat;
  });

  return {
    id: pData.id,
    name: pData.name,
    sprite: pData.sprites.front_default,
    spriteBack: pData.sprites.back_default || pData.sprites.front_default,
    types: pData.types.map(t => t.type.name),
    height: pData.height,   // décimètres
    weight: pData.weight,   // hectogrammes
    color,
    hp: stats.hp || 45,
    generation: getGeneration(pData.id),
    moves: validMoves,
    stats: {
      hp: stats.hp || 45,
      attack: stats.attack || 50,
      defense: stats.defense || 50,
      speed: stats.speed || 50,
    },
  };
}

async function fetchThreeRandomPokemon() {
  const ids = new Set();
  while (ids.size < 3) ids.add(Math.floor(Math.random() * TOTAL_POKEMON) + 1);
  return Promise.all([...ids].map(fetchPokemon));
}

/* ──────────────────────────────────────────────
   SCREEN MANAGER
────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ──────────────────────────────────────────────
   LOBBY
────────────────────────────────────────────── */
document.getElementById('btn-create').addEventListener('click', () => {
  const username = document.getElementById('username-input').value.trim();
  if (!username) return showError('Entre ton nom de dresseur !');
  state.username = username;
  socket.emit('create_room', { username });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const username = document.getElementById('username-input').value.trim();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!username) return showError('Entre ton nom de dresseur !');
  if (code.length !== 5) return showError('Le code doit faire 5 caractères.');
  state.username = username;
  socket.emit('join_room', { code, username });
});

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

/* ──────────────────────────────────────────────
   SOCKET — LOBBY EVENTS
────────────────────────────────────────────── */
socket.on('room_created', ({ code, role }) => {
  state.role = role;
  state.roomCode = code;
  document.getElementById('room-code-display').textContent = code;
  document.getElementById('room-created-info').classList.remove('hidden');
});

socket.on('room_joined', ({ code, role, username, opponent }) => {
  state.role = role;
  state.roomCode = code;
  state.username = username;
  state.opponent = opponent;
});

socket.on('opponent_joined', ({ username }) => {
  state.opponent = username;
  // Host sees opponent joined — transition to draft
  initDraftScreen();
});

socket.on('players_update', ({ players }) => {
  players.forEach(p => {
    if (p.role === state.role) {
      state.myBudget = p.budget;
      state.myTeam = state.myTeam; // already tracked locally
    } else {
      state.oppBudget = p.budget;
    }
    updateDraftHeader(players);
  });
});

socket.on('error', (msg) => {
  showError(msg);
});

/* ──────────────────────────────────────────────
   DRAFT — INIT
────────────────────────────────────────────── */
function initDraftScreen() {
  showScreen('screen-draft');

  document.getElementById('draft-your-name').textContent = state.username;
  document.getElementById('draft-opp-name').textContent = state.opponent;
  document.getElementById('draft-your-count').textContent = '0/6 🔴';
  document.getElementById('draft-opp-count').textContent = '0/6 🔵';

  if (state.role === 'host') {
    document.getElementById('host-controls').classList.remove('hidden');
  } else {
    document.getElementById('host-controls').classList.add('hidden');
  }

  document.getElementById('your-team-sprites').innerHTML = '';
  document.getElementById('opp-team-sprites').innerHTML = '';
  document.getElementById('offers-grid').innerHTML = '';
  document.getElementById('draft-status').textContent = '';
}

// When client receives draft_started, go to draft screen
socket.on('draft_started', ({ mode }) => {
  state.draftMode = mode;
  state.myTeam = [];
  state.oppTeam = [];
  state.myBudget = 1000;
  state.oppBudget = 1000;

  const modeLabels = {
    type: '🔥 Types',
    size: '📏 Taille/Poids',
    pokedex: '🔢 Pokédex',
    color: '🎨 Couleur',
    hp: '❤️ Points de Vie',
    generation: '🌍 Génération',
    auction: '💰 Enchère',
  };

  document.getElementById('draft-mode-label').textContent = modeLabels[mode] || mode;

  if (mode === 'auction') {
    document.getElementById('draft-your-budget').style.display = '';
    document.getElementById('draft-opp-budget').style.display = '';
    updateBudgetDisplays();
  }

  if (state.role === 'client') {
    initDraftScreen();
    document.getElementById('draft-mode-label').textContent = modeLabels[mode] || mode;
    if (mode === 'auction') {
      document.getElementById('draft-your-budget').style.display = '';
      document.getElementById('draft-opp-budget').style.display = '';
    }
    document.getElementById('draft-status').textContent = 'En attente du Host pour générer les offres...';
  }
});

/* ──────────────────────────────────────────────
   HOST — GENERATE BUTTON
────────────────────────────────────────────── */
document.getElementById('btn-generate').addEventListener('click', async () => {
  const mode = document.getElementById('mode-select').value;
  state.draftMode = mode;

  document.getElementById('btn-generate').disabled = true;
  document.getElementById('btn-generate').textContent = '⏳ Chargement...';

  // Start draft if not started yet (first generate)
  socket.emit('start_draft', { mode });

  try {
    const pokemons = await fetchThreeRandomPokemon();
    state.currentOffers = pokemons;
    socket.emit('request_offers', { pokemons });
  } catch (e) {
    console.error(e);
    document.getElementById('draft-status').textContent = 'Erreur API. Réessaie.';
  }

  document.getElementById('btn-generate').disabled = false;
  document.getElementById('btn-generate').textContent = '⚡ GÉNÉRER 3 POKÉMON';
});

/* ──────────────────────────────────────────────
   SOCKET — OFFERS UPDATE
────────────────────────────────────────────── */
socket.on('offers_update', ({ pokemons, isHost, mode }) => {
  state.currentOffers = pokemons;
  state.draftMode = mode;

  // Reset auction panel
  document.getElementById('auction-panel').classList.add('hidden');
  document.getElementById('btn-adjuge') && document.getElementById('btn-adjuge').classList.add('hidden');

  renderOffers(pokemons, isHost, mode);
});

/* ──────────────────────────────────────────────
   RENDER OFFERS
────────────────────────────────────────────── */
function renderOffers(pokemons, isHost, mode) {
  const grid = document.getElementById('offers-grid');
  grid.innerHTML = '';

  pokemons.forEach((pkmn, idx) => {
    const card = document.createElement('div');
    card.className = 'offer-card';
    card.dataset.idx = idx;

    if (isHost) {
      // Host sees full info
      card.innerHTML = `
        <img src="${pkmn.sprite}" alt="${pkmn.name}" />
        <div class="pkmn-name">${pkmn.name}</div>
        <div class="pkmn-id">#${String(pkmn.id).padStart(4, '0')}</div>
        <div class="types-row">${pkmn.types.map(t => `<span class="type-badge type-${t}">${t.toUpperCase()}</span>`).join('')}</div>
      `;

      if (mode === 'auction') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary pick-btn';
        btn.textContent = '⚡ LANCER L\'ENCHÈRE';
        btn.addEventListener('click', () => {
          socket.emit('start_auction', { offerIndex: idx });
        });
        card.appendChild(btn);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary pick-btn';
        btn.textContent = '✅ CHOISIR';
        btn.addEventListener('click', () => {
          pickPokemon(pkmn, 'host');
          grid.querySelectorAll('.offer-card').forEach(c => {
            c.querySelector('.pick-btn') && (c.querySelector('.pick-btn').disabled = true);
          });
        });
        card.appendChild(btn);
      }
    } else {
      // Client sees pokéball + hint
      const hint = buildHint(pkmn, mode);
      card.innerHTML = `
        <div class="pokeball-card">
          <img class="pokeball-img" src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png" alt="Pokéball" />
          <div class="hint-box">${hint}</div>
        </div>
      `;

      if (mode !== 'auction') {
        // Client picks for themselves in non-auction mode - disabled, only host picks
        // Actually per server logic: host picks for host slot, but client should also pick
        // The server uses pickerRole param. We'll let client pick for client slot.
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary pick-btn';
        btn.textContent = '🎲 CHOISIR À L\'AVEUGLE';
        btn.addEventListener('click', () => {
          pickPokemon(pkmn, 'client');
          grid.querySelectorAll('.offer-card').forEach(c => {
            c.querySelector('.pick-btn') && (c.querySelector('.pick-btn').disabled = true);
          });
        });
        card.appendChild(btn);
      }
    }

    grid.appendChild(card);
  });
}

function buildHint(pkmn, mode) {
  switch (mode) {
    case 'type':
      return pkmn.types.map(t => `<span class="type-badge type-${t}">${t.toUpperCase()}</span>`).join(' ');
    case 'size':
      return `📏 ${(pkmn.height / 10).toFixed(1)}m &nbsp; ⚖️ ${(pkmn.weight / 10).toFixed(1)}kg`;
    case 'pokedex':
      return `#${String(pkmn.id).padStart(4, '0')}`;
    case 'color':
      return `🎨 ${pkmn.color.charAt(0).toUpperCase() + pkmn.color.slice(1)}`;
    case 'hp':
      return `❤️ ${pkmn.hp} PV`;
    case 'generation':
      return `🌍 ${pkmn.generation}`;
    case 'auction':
      return `💰 Enchère`;
    default:
      return '❓ ???';
  }
}

/* ──────────────────────────────────────────────
   PICK POKEMON (NON-AUCTION)
────────────────────────────────────────────── */
function pickPokemon(pokemon, pickerRole) {
  socket.emit('pick_pokemon', { pokemon, pickerRole });
}

socket.on('pokemon_picked', ({ role, username, pokemon, teamCount }) => {
  const isMe = role === state.role;
  if (isMe) {
    state.myTeam.push(pokemon);
    addTeamSprite('your-team-sprites', pokemon.sprite, pokemon.name);
    document.getElementById('draft-your-count').textContent = `${state.myTeam.length}/6 🔴`;
  } else {
    state.oppTeam.push(pokemon);
    addTeamSprite('opp-team-sprites', pokemon.sprite, pokemon.name);
    document.getElementById('draft-opp-count').textContent = `${state.oppTeam.length}/6 🔵`;
  }

  document.getElementById('draft-status').textContent =
    `${username} a choisi ${pokemon.name} !`;
});

function addTeamSprite(containerId, spriteUrl, name) {
  const container = document.getElementById(containerId);
  const img = document.createElement('img');
  img.src = spriteUrl;
  img.alt = name;
  img.className = 'team-sprite-mini';
  img.title = name;
  container.appendChild(img);
}

/* ──────────────────────────────────────────────
   AUCTION SYSTEM
────────────────────────────────────────────── */
socket.on('auction_started', ({ offerIndex, pokemon, players }) => {
  state.auctionActive = true;

  // Highlight the card in auction
  document.querySelectorAll('.offer-card').forEach((c, i) => {
    c.classList.toggle('in-auction', i === offerIndex);
  });

  // Show auction panel
  const panel = document.getElementById('auction-panel');
  panel.classList.remove('hidden');
  document.getElementById('auction-pkmn-name').textContent = pokemon.name;
  document.getElementById('auction-bid-amount').textContent = '0₽';
  document.getElementById('auction-bidder-name').textContent = '—';

  // Show adjuge button only for host
  if (state.role === 'host') {
    document.getElementById('btn-adjuge').classList.remove('hidden');
  }

  updateBudgetDisplays(players);
  document.getElementById('draft-status').textContent = `Enchère ouverte pour ${pokemon.name} !`;
});

socket.on('bid_update', ({ highestBid, highestBidder, highestBidderRole, players }) => {
  document.getElementById('auction-bid-amount').textContent = `${highestBid}₽`;
  document.getElementById('auction-bidder-name').textContent = highestBidder;
  updateBudgetDisplays(players);
});

socket.on('auction_closed', ({ winner, winnerRole, pokemon, finalBid, players }) => {
  state.auctionActive = false;
  document.getElementById('auction-panel').classList.add('hidden');
  document.getElementById('btn-adjuge').classList.add('hidden');

  if (winner && pokemon) {
    const isMe = winnerRole === state.role;
    document.getElementById('draft-status').textContent =
      `🏆 ${winner} remporte ${pokemon.name} pour ${finalBid}₽ !`;

    if (players) updateBudgetDisplays(players);
  } else {
    document.getElementById('draft-status').textContent = 'Pas d\'enchère — Pokémon non attribué.';
  }
});

document.getElementById('btn-bid-10').addEventListener('click', () => {
  if (state.auctionActive) socket.emit('place_bid', { amount: 10 });
});

document.getElementById('btn-bid-50').addEventListener('click', () => {
  if (state.auctionActive) socket.emit('place_bid', { amount: 50 });
});

document.getElementById('btn-adjuge').addEventListener('click', () => {
  socket.emit('close_auction');
});

function updateBudgetDisplays(players) {
  if (!players) {
    document.getElementById('draft-your-budget').textContent = `💰 ${state.myBudget}₽`;
    document.getElementById('draft-opp-budget').textContent = `💰 ${state.oppBudget}₽`;
    return;
  }
  players.forEach(p => {
    if (p.role === state.role) {
      state.myBudget = p.budget;
      document.getElementById('draft-your-budget').textContent = `💰 ${p.budget}₽`;
    } else {
      state.oppBudget = p.budget;
      document.getElementById('draft-opp-budget').textContent = `💰 ${p.budget}₽`;
    }
    if (p.role === state.role) {
      document.getElementById('draft-your-count').textContent = `${state.myTeam.length}/6 🔴`;
    } else {
      document.getElementById('draft-opp-count').textContent = `${state.oppTeam.length}/6 🔵`;
    }
  });
}

function updateDraftHeader(players) {
  players.forEach(p => {
    if (p.role === state.role) {
      document.getElementById('draft-your-count').textContent = `${p.teamCount}/6 🔴`;
      document.getElementById('draft-your-budget').textContent = `💰 ${p.budget}₽`;
    } else {
      document.getElementById('draft-opp-count').textContent = `${p.teamCount}/6 🔵`;
      document.getElementById('draft-opp-budget').textContent = `💰 ${p.budget}₽`;
    }
  });
}

/* ──────────────────────────────────────────────
   DRAFT COMPLETE → BATTLE
────────────────────────────────────────────── */
socket.on('draft_complete', ({ hostTeam, clientTeam }) => {
  document.getElementById('draft-status').textContent = '🎮 Draft terminée ! Préparation du combat...';

  // Give UI a moment
  setTimeout(() => {
    if (state.role === 'host') {
      socket.emit('init_battle', { hostTeam, clientTeam });
    }
  }, 1500);
});

/* ──────────────────────────────────────────────
   BATTLE — INIT
────────────────────────────────────────────── */
socket.on('battle_started', (battleState) => {
  showScreen('screen-battle');
  renderBattleState(battleState);
});

socket.on('battle_state', (battleState) => {
  renderBattleState(battleState);
});

socket.on('waiting_for_opponent', () => {
  showWaitingOverlay(true);
  document.getElementById('draft-status') && (document.getElementById('draft-status').textContent = 'En attente de l\'adversaire...');
});

/* ──────────────────────────────────────────────
   BATTLE — RENDER
────────────────────────────────────────────── */
function renderBattleState(bs) {
  const myRole = state.role;
  const mySide = bs[myRole];
  const oppRole = myRole === 'host' ? 'client' : 'host';
  const oppSide = bs[oppRole];

  const myActive = mySide.activePokemon;
  const oppActive = oppSide.activePokemon;

  // Sprites
  document.getElementById('player-sprite').src = myActive.spriteBack || myActive.sprite;
  document.getElementById('enemy-sprite').src = oppActive.sprite;

  // Names
  document.getElementById('player-name').textContent = myActive.name;
  document.getElementById('enemy-name').textContent = oppActive.name;

  // HP bars
  updateHPBar('player-hp-bar', 'player-hp-numbers', myActive.currentHp, myActive.maxHp);
  updateHPBar('enemy-hp-bar', 'enemy-hp-numbers', oppActive.currentHp, oppActive.maxHp);

  // Moves
  renderMoves(myActive);

  // Team slots
  renderTeamSlots(mySide.team, mySide.activePokemonIndex);

  // Team overview bars
  renderTeamBar('player-team-row', mySide.team, mySide.activePokemonIndex);
  renderTeamBar('enemy-team-row', oppSide.team, oppSide.activePokemonIndex);

  // Log
  renderBattleLog(bs.log);

  // Remove waiting overlay
  showWaitingOverlay(false);
  state.myPendingAction = false;

  // Winner
  if (bs.winner) {
    showWinner(bs.winner);
  }
}

function updateHPBar(barId, numbersId, current, max) {
  const pct = max > 0 ? (current / max) * 100 : 0;
  const bar = document.getElementById(barId);
  bar.style.width = `${pct}%`;
  bar.classList.remove('yellow', 'red');
  if (pct <= 20) bar.classList.add('red');
  else if (pct <= 50) bar.classList.add('yellow');
  document.getElementById(numbersId).textContent = `${current}/${max}`;
}

function renderMoves(pokemon) {
  const grid = document.getElementById('moves-grid');
  grid.innerHTML = '';
  if (!pokemon.moves) return;

  pokemon.moves.forEach((move, i) => {
    const btn = document.createElement('button');
    btn.className = 'move-btn';
    btn.innerHTML = `${move.name} <span class="move-power">${move.power || '—'}</span>`;
    btn.addEventListener('click', () => {
      if (state.myPendingAction) return;
      state.myPendingAction = true;
      socket.emit('battle_action', { action: 'move', moveIndex: i });
      showWaitingOverlay(true);
    });
    grid.appendChild(btn);
  });
}

function renderTeamSlots(team, activeIndex) {
  const container = document.getElementById('team-slots');
  container.innerHTML = '';
  team.forEach((pkmn, i) => {
    const slot = document.createElement('div');
    slot.className = 'team-slot' + (i === activeIndex ? ' active' : '') + (pkmn.currentHp <= 0 ? ' fainted' : '');
    const img = document.createElement('img');
    img.src = pkmn.sprite;
    img.alt = pkmn.name;
    slot.appendChild(img);
    if (pkmn.currentHp > 0 && i !== activeIndex) {
      slot.addEventListener('click', () => {
        socket.emit('switch_pokemon', { index: i });
      });
    }
    container.appendChild(slot);
  });
}

function renderTeamBar(rowId, team, activeIndex) {
  const row = document.getElementById(rowId);
  row.innerHTML = '';
  team.forEach((pkmn, i) => {
    const ind = document.createElement('div');
    ind.className = 'team-indicator' + (i === activeIndex ? ' active' : '') + (pkmn.currentHp <= 0 ? ' fainted' : '');
    const img = document.createElement('img');
    img.src = pkmn.sprite;
    img.alt = pkmn.name;
    img.title = pkmn.name;
    ind.appendChild(img);
    row.appendChild(ind);
  });
}

function renderBattleLog(entries) {
  const log = document.getElementById('battle-log');
  log.innerHTML = '';
  (entries || []).forEach(entry => {
    const p = document.createElement('p');
    p.className = 'log-entry';
    p.textContent = entry;
    log.appendChild(p);
  });
  log.scrollTop = log.scrollHeight;
}

function showWaitingOverlay(show) {
  let overlay = document.getElementById('waiting-overlay-battle');
  if (!overlay && show) {
    overlay = document.createElement('div');
    overlay.id = 'waiting-overlay-battle';
    overlay.className = 'waiting-overlay';
    overlay.innerHTML = '<div class="waiting-label">⏳ EN ATTENTE DE L\'ADVERSAIRE...</div>';
    document.getElementById('battle-actions').appendChild(overlay);
    document.getElementById('battle-actions').style.position = 'relative';
  }
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

function showWinner(winnerName) {
  const overlay = document.getElementById('winner-overlay');
  overlay.classList.remove('hidden');
  const isMe = winnerName === state.username;
  document.getElementById('winner-title').textContent = isMe ? '🏆 VICTOIRE !' : '💀 DÉFAITE...';
  document.getElementById('winner-name').textContent = winnerName;
}

/* ──────────────────────────────────────────────
   DISCONNECT
────────────────────────────────────────────── */
socket.on('player_disconnected', ({ message }) => {
  alert(message);
  location.reload();
});

/* ──────────────────────────────────────────────
   INIT — Start on Lobby
────────────────────────────────────────────── */
showScreen('screen-lobby');