import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import {
  createDeck,
  shuffleDeck,
  dealCards,
  evaluateHand,
  compareHands,
} from './gameLogic.js';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const INITIAL_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

// Store all rooms
const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createRoom(hostSocketId, hostName) {
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    players: [
      {
        id: uuidv4(),
        socketId: hostSocketId,
        name: hostName,
        chips: INITIAL_CHIPS,
        cards: [],
        currentBet: 0,
        folded: false,
        isAllIn: false,
        hasActed: false,
        isConnected: true,
      },
    ],
    gameState: null,
    phase: 'waiting', // waiting, playing
  };
  rooms.set(roomCode, room);
  return room;
}

function createGameState(room) {
  let deck = shuffleDeck(createDeck());

  // Deal cards to each player
  const players = room.players.map((player, index) => {
    const { cards, remainingDeck } = dealCards(deck, 2);
    deck = remainingDeck;
    return {
      ...player,
      cards,
      currentBet: 0,
      folded: false,
      isAllIn: false,
      hasActed: false,
    };
  });

  // Set dealer and blinds
  const dealerIndex = room.gameState?.dealerIndex !== undefined
    ? (room.gameState.dealerIndex + 1) % players.length
    : 0;

  const sbIndex = dealerIndex;
  const bbIndex = (dealerIndex + 1) % players.length;

  const sbAmount = Math.min(SMALL_BLIND, players[sbIndex].chips);
  const bbAmount = Math.min(BIG_BLIND, players[bbIndex].chips);

  players[sbIndex].chips -= sbAmount;
  players[sbIndex].currentBet = sbAmount;
  if (players[sbIndex].chips === 0) players[sbIndex].isAllIn = true;

  players[bbIndex].chips -= bbAmount;
  players[bbIndex].currentBet = bbAmount;
  if (players[bbIndex].chips === 0) players[bbIndex].isAllIn = true;

  // In heads-up, dealer (SB) acts first preflop
  const firstToAct = sbIndex;

  return {
    players,
    communityCards: [],
    pot: sbAmount + bbAmount,
    currentPlayerIndex: firstToAct,
    dealerIndex,
    phase: 'preflop',
    currentBet: bbAmount,
    minRaise: BIG_BLIND,
    deck,
    winner: null,
    winningHand: null,
  };
}

function getPlayerView(gameState, playerId) {
  // Return game state with opponent's cards hidden
  return {
    ...gameState,
    deck: undefined, // Don't send deck to client
    players: gameState.players.map((p) => ({
      ...p,
      cards: p.id === playerId || gameState.phase === 'showdown'
        ? p.cards.map(c => ({ ...c, faceUp: true }))
        : p.cards.map(() => ({ faceUp: false })),
    })),
  };
}

function checkBettingRoundComplete(gameState) {
  const activePlayers = gameState.players.filter(p => !p.folded && !p.isAllIn);

  if (activePlayers.length === 0) return true;
  if (activePlayers.length === 1 && gameState.players.filter(p => !p.folded).length === 1) {
    return true;
  }

  return activePlayers.every(
    p => p.hasActed && p.currentBet === gameState.currentBet
  );
}

function determineWinner(gameState) {
  const activePlayers = gameState.players.filter(p => !p.folded);

  if (activePlayers.length === 1) {
    const winner = activePlayers[0];
    const updatedPlayers = gameState.players.map(p =>
      p.id === winner.id
        ? { ...p, chips: p.chips + gameState.pot }
        : p
    );
    return {
      ...gameState,
      players: updatedPlayers,
      winner: { id: winner.id, name: winner.name },
      winningHand: 'Other player folded',
      pot: 0,
      phase: 'showdown',
    };
  }

  const playerHands = activePlayers.map(player => ({
    player,
    hand: evaluateHand(player.cards, gameState.communityCards),
  }));

  playerHands.sort((a, b) => compareHands(b.hand, a.hand));

  const winner = playerHands[0].player;
  const winningHand = playerHands[0].hand.name;

  const updatedPlayers = gameState.players.map(p => ({
    ...p,
    chips: p.id === winner.id ? p.chips + gameState.pot : p.chips,
  }));

  return {
    ...gameState,
    players: updatedPlayers,
    winner: { id: winner.id, name: winner.name },
    winningHand,
    pot: 0,
    phase: 'showdown',
  };
}

function moveToNextPhase(gameState) {
  const phases = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const currentPhaseIndex = phases.indexOf(gameState.phase);

  if (currentPhaseIndex >= phases.length - 1) {
    return gameState;
  }

  const nextPhase = phases[currentPhaseIndex + 1];
  let newCommunityCards = [...gameState.communityCards];
  let deck = [...gameState.deck];

  if (nextPhase === 'flop') {
    deck = deck.slice(1); // Burn
    const { cards, remainingDeck } = dealCards(deck, 3);
    newCommunityCards = cards.map(c => ({ ...c, faceUp: true }));
    deck = remainingDeck;
  } else if (nextPhase === 'turn' || nextPhase === 'river') {
    deck = deck.slice(1); // Burn
    const { cards, remainingDeck } = dealCards(deck, 1);
    newCommunityCards = [...newCommunityCards, { ...cards[0], faceUp: true }];
    deck = remainingDeck;
  }

  const resetPlayers = gameState.players.map(p => ({
    ...p,
    currentBet: 0,
    hasActed: false,
  }));

  let firstToAct = (gameState.dealerIndex + 1) % gameState.players.length;
  while (resetPlayers[firstToAct].folded || resetPlayers[firstToAct].isAllIn) {
    firstToAct = (firstToAct + 1) % gameState.players.length;
    if (firstToAct === gameState.dealerIndex) break;
  }

  if (nextPhase === 'showdown') {
    return determineWinner({ ...gameState, phase: 'showdown' });
  }

  return {
    ...gameState,
    phase: nextPhase,
    communityCards: newCommunityCards,
    deck,
    currentBet: 0,
    minRaise: BIG_BLIND,
    players: resetPlayers,
    currentPlayerIndex: firstToAct,
  };
}

function processAction(gameState, playerId, action, amount) {
  const playerIndex = gameState.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return gameState;

  const player = gameState.players[playerIndex];
  let updatedPlayers = [...gameState.players];
  let newPot = gameState.pot;
  let newCurrentBet = gameState.currentBet;
  let newMinRaise = gameState.minRaise;

  switch (action) {
    case 'fold':
      updatedPlayers[playerIndex] = { ...player, folded: true, hasActed: true };
      break;

    case 'check':
      updatedPlayers[playerIndex] = { ...player, hasActed: true };
      break;

    case 'call': {
      const callAmount = Math.min(gameState.currentBet - player.currentBet, player.chips);
      updatedPlayers[playerIndex] = {
        ...player,
        chips: player.chips - callAmount,
        currentBet: player.currentBet + callAmount,
        isAllIn: player.chips - callAmount === 0,
        hasActed: true,
      };
      newPot += callAmount;
      break;
    }

    case 'raise': {
      const raiseAmount = amount || gameState.currentBet + gameState.minRaise;
      const totalBet = Math.min(raiseAmount, player.chips + player.currentBet);
      const additionalBet = totalBet - player.currentBet;

      newMinRaise = Math.max(gameState.minRaise, totalBet - gameState.currentBet);
      newCurrentBet = totalBet;

      updatedPlayers[playerIndex] = {
        ...player,
        chips: player.chips - additionalBet,
        currentBet: totalBet,
        isAllIn: player.chips - additionalBet === 0,
        hasActed: true,
      };
      newPot += additionalBet;

      updatedPlayers = updatedPlayers.map((p, i) =>
        i === playerIndex ? updatedPlayers[playerIndex] : { ...p, hasActed: p.folded || p.isAllIn }
      );
      break;
    }

    case 'all-in': {
      const allInAmount = player.chips;
      const newBet = player.currentBet + allInAmount;

      if (newBet > gameState.currentBet) {
        newMinRaise = Math.max(gameState.minRaise, newBet - gameState.currentBet);
        newCurrentBet = newBet;
        updatedPlayers = updatedPlayers.map((p, i) =>
          i === playerIndex ? p : { ...p, hasActed: p.folded || p.isAllIn }
        );
      }

      updatedPlayers[playerIndex] = {
        ...player,
        chips: 0,
        currentBet: newBet,
        isAllIn: true,
        hasActed: true,
      };
      newPot += allInAmount;
      break;
    }
  }

  let newState = {
    ...gameState,
    players: updatedPlayers,
    pot: newPot,
    currentBet: newCurrentBet,
    minRaise: newMinRaise,
  };

  const remainingPlayers = updatedPlayers.filter(p => !p.folded);
  if (remainingPlayers.length === 1) {
    return determineWinner(newState);
  }

  if (checkBettingRoundComplete(newState)) {
    const nonFoldedNonAllIn = updatedPlayers.filter(p => !p.folded && !p.isAllIn);
    if (nonFoldedNonAllIn.length <= 1) {
      let finalState = newState;
      while (finalState.phase !== 'showdown') {
        finalState = moveToNextPhase(finalState);
      }
      return finalState;
    }
    return moveToNextPhase(newState);
  }

  let nextPlayerIndex = (playerIndex + 1) % gameState.players.length;
  while (
    updatedPlayers[nextPlayerIndex].folded ||
    updatedPlayers[nextPlayerIndex].isAllIn
  ) {
    nextPlayerIndex = (nextPlayerIndex + 1) % gameState.players.length;
  }

  return { ...newState, currentPlayerIndex: nextPlayerIndex };
}

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', ({ playerName }, callback) => {
    const room = createRoom(socket.id, playerName);
    socket.join(room.code);
    const player = room.players[0];
    callback({
      success: true,
      roomCode: room.code,
      playerId: player.id,
      playerName: player.name,
    });
    console.log(`Room ${room.code} created by ${playerName}`);
  });

  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    if (room.players.length >= 2) {
      callback({ success: false, error: 'Room is full' });
      return;
    }

    if (room.phase !== 'waiting') {
      callback({ success: false, error: 'Game already in progress' });
      return;
    }

    const newPlayer = {
      id: uuidv4(),
      socketId: socket.id,
      name: playerName,
      chips: INITIAL_CHIPS,
      cards: [],
      currentBet: 0,
      folded: false,
      isAllIn: false,
      hasActed: false,
      isConnected: true,
    };

    room.players.push(newPlayer);
    socket.join(roomCode.toUpperCase());

    callback({
      success: true,
      roomCode: room.code,
      playerId: newPlayer.id,
      playerName: newPlayer.name,
    });

    // Notify all players in room
    io.to(room.code).emit('playerJoined', {
      players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips })),
    });

    console.log(`${playerName} joined room ${room.code}`);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.players.length < 2) return;

    room.phase = 'playing';
    room.gameState = createGameState(room);

    // Send personalized game state to each player
    room.players.forEach((player) => {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('gameStarted', {
          gameState: getPlayerView(room.gameState, player.id),
          yourPlayerId: player.id,
        });
      }
    });

    console.log(`Game started in room ${roomCode}`);
  });

  socket.on('playerAction', ({ roomCode, playerId, action, amount }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.gameState) return;

    const currentPlayer = room.gameState.players[room.gameState.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      console.log('Not this player\'s turn');
      return;
    }

    room.gameState = processAction(room.gameState, playerId, action, amount);

    // Broadcast updated state to all players
    room.players.forEach((player) => {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('gameStateUpdate', {
          gameState: getPlayerView(room.gameState, player.id),
          lastAction: { playerId, playerName: currentPlayer.name, action, amount },
        });
      }
    });

    console.log(`${currentPlayer.name} performed ${action} in room ${roomCode}`);
  });

  socket.on('nextHand', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    // Check if any player is out of chips
    const playersWithChips = room.gameState.players.filter(p => p.chips > 0);
    if (playersWithChips.length < 2) {
      io.to(roomCode).emit('gameOver', {
        winner: playersWithChips[0],
      });
      return;
    }

    // Preserve chip counts
    room.players = room.players.map((p, i) => ({
      ...p,
      chips: room.gameState.players[i].chips,
    }));

    room.gameState = createGameState(room);

    room.players.forEach((player) => {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('newHand', {
          gameState: getPlayerView(room.gameState, player.id),
        });
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    // Find and update room
    for (const [code, room] of rooms) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIndex !== -1) {
        room.players[playerIndex].isConnected = false;

        io.to(code).emit('playerDisconnected', {
          playerId: room.players[playerIndex].id,
          playerName: room.players[playerIndex].name,
        });

        // Clean up empty rooms after a delay
        setTimeout(() => {
          const room = rooms.get(code);
          if (room && room.players.every(p => !p.isConnected)) {
            rooms.delete(code);
            console.log(`Room ${code} deleted`);
          }
        }, 60000);

        break;
      }
    }
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Poker server running', rooms: rooms.size });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Poker server running on port ${PORT}`);
});
