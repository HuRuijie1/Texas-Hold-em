# Repository Guidelines

## Project Structure & Module Organization
- src/ contains the Node.js server, realtime game logic, room management, persistence, and bot helpers.
- public/ holds the browser client (client.js), page shell (index.html), and shared styles (styles.css).
- 	est/ contains automated tests, including unit coverage for the game engine and integration checks for realtime behavior.
- data/ stores the SQLite database (poker.sqlite) and any runtime state snapshots.

## Build, Test, and Development Commands
- 
pm install installs dependencies.
- 
pm start runs the server with Node.js on the default port (3000).
- 
pm run dev starts the server with file watching for local development.
- 
pm test runs the full test suite via 
ode --test.

## Coding Style & Naming Conventions
- Use modern JavaScript ES modules (	ype:  module) and prefer const/let over ar.
- Follow the existing style: descriptive camelCase names for variables, functions, and files such as game-engine.js and ealtime-app.js.
- Keep server and client changes small and focused; preserve the current formatting in nearby code.

## Testing Guidelines
- Tests use Node's built-in 
ode:test runner.
- Place new tests under 	est/ and name them *.test.js or *.integration.test.mjs to match the current layout.
- Prefer adding targeted tests for game rules, room state transitions, and reconnect handling.

## Commit & Pull Request Guidelines
- No Git history is available in this workspace, so follow clear, imperative commit messages such as Fix reconnect state recovery.
- In pull requests, include a short summary, testing notes (
pm test), and screenshots or screen recordings for UI changes.
- Call out database or protocol changes explicitly so reviewers can verify compatibility.

## Security & Configuration Tips
- Do not commit generated data files from data/ unless they are required fixtures.
- If you change the default port or persistence behavior, document the impact in the README and tests.
