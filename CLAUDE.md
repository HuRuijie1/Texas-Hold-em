# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time Texas Hold'em poker application with WebSocket-based multiplayer. The server handles all game logic, room management, and state persistence using SQLite. The client is a vanilla JavaScript SPA that communicates via Socket.IO.

## Development Commands

```bash
# Install dependencies
npm install

# Start the server (default port 3000)
npm start

# Start with file watching for development
npm run dev

# Run all tests
npm test

# Change the port (PowerShell)
$env:PORT = 4000; npm start

# Change the port (cmd)
set PORT=4000&& npm start
```

## Architecture

### Server-Side Structure (src/)

The application follows a layered architecture:

1. **server.js** - Entry point that creates and starts the HTTP server
2. **realtime-app.js** - Main application layer that wires Express, Socket.IO, and GameManager together. Handles all WebSocket events and REST endpoints.
3. **game-engine.js** - Core game state machine (`GameManager` class). Manages rooms, hands, betting rounds, pot calculations, and player actions. All game logic lives here.
4. **poker.js** - Pure poker logic utilities: deck creation, shuffling, hand evaluation (7-card best hand), seat ordering, and card formatting.
5. **bot-ai.js** - Bot decision-making logic with difficulty levels
6. **store.js** - Persistence layer (`RoomStore` class) using Node.js built-in SQLite (`node:sqlite`). Stores room snapshots and hand history.

### Client-Side (public/)

- **index.html** - Single-page shell
- **client.js** - All client logic: Socket.IO connection, UI rendering, event handling, reconnection logic
- **styles.css** - Responsive styles with mobile support

### Key Architectural Patterns

- **Server Authority**: All game state is computed server-side. Clients receive personalized views via `getRoomView()` which filters private information (other players' hole cards).
- **Event-Driven Updates**: `GameManager` uses callbacks (`onUpdate`, `onHandStart`) to push state changes to connected clients via Socket.IO.
- **Token-Based Identity**: Players are identified by UUIDs stored in browser localStorage. This enables reconnection without accounts.
- **Socket Mapping**: Each room maintains a `socketMap` (token → socketId) to route personalized state updates.
- **Graceful Disconnection**: Players have a 2-minute grace period (`disconnectGraceMs`) to reconnect before being auto-sat-out.

## Database Schema

SQLite database at `data/poker.sqlite`:

- **rooms** table: `room_code`, `snapshot` (JSON), `updated_at`
- **hand_history** table: `room_code`, `hand_no`, `summary` (JSON), `created_at`

Rooms are persisted after every state change. On server restart, rooms are restored from snapshots.

## Game State Flow

1. **Room Creation**: `GameManager.createRoom()` generates a 6-character code, initializes room state
2. **Player Join**: Socket connects with token, joins room via `joinRoom()`
3. **Sit Down**: Player claims a seat (0-8), gets starting stack
4. **Hand Start**: When ≥2 seated players, host can start. Blinds posted, cards dealt, action begins.
5. **Betting Rounds**: Preflop → Flop → Turn → River. Each round collects bets into pot(s).
6. **Showdown/Fold**: Last player standing or showdown determines winner(s). Pots split with side pot logic.
7. **Cleanup**: Button rotates, next hand can begin

## Testing

- **test/game-engine.test.js**: Unit tests for core game logic (pot splitting, hand evaluation, action validation)
- **test/realtime-app.integration.test.mjs**: Integration tests with real Socket.IO clients

When adding features:
- Test game state transitions in game-engine.test.js
- Test WebSocket flows in integration tests
- Manually verify UI changes in a browser (test both desktop and mobile views)

## Critical Constraints

- **Node.js 22+** required for `node:sqlite` (DatabaseSync API)
- **ES Modules**: All files use `type: "module"`, no CommonJS
- **No Authentication**: Token-based identity only, no passwords or user accounts
- **Single Process**: No horizontal scaling support (rooms live in memory)
- **Chinese UI**: All player-facing text is in Chinese

## Configuration

Game defaults in `DEFAULT_CONFIG` (game-engine.js):
- 9 seats max, 2000 starting stack
- 10/20 blinds
- 30s action timeout, 2min disconnect grace
- 30min idle room cleanup

To modify, pass config to `GameManager` constructor in realtime-app.js.

## Common Patterns

### Adding a New Player Action

1. Add the action logic to `GameManager` in game-engine.js
2. Add validation in the action method
3. Call `this.notifyUpdate()` to trigger state push
4. Add Socket.IO event handler in realtime-app.js
5. Wire up client UI in client.js

### Debugging State Issues

- Check server console for errors
- Inspect `room` object in GameManager methods (logged on critical transitions)
- Use Socket.IO dev tools to see event flow
- Check SQLite snapshot: `SELECT * FROM rooms WHERE room_code = 'ABCD12'`

## Important Notes

- Never expose hole cards of non-folded players in `getRoomView()` unless showdown
- Always validate action amounts (raise must be ≥ minRaise, ≤ stack)
- Side pot logic in `collectBets()` handles all-in scenarios automatically
- Bots are stored as regular players with `isBot: true` flag
