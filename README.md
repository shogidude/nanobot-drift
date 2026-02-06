# Nanobot Drift

A small, self-contained browser mini-game inspired by classic inertia shooters.

**Premise:** context-shifted AI nanobot swarms drift in and attempt to "help" by assimilating your ship. Keep them off long enough to charge a containment beacon and broadcast a universal reframe signal.

## Controls

- **Rotate:** A / D or Left / Right
- **Thrust:** W or Up
- **Brake (gentle):** S or Down
- **Fire:** Space
- **EMP Burst (detach + repel):** E or Shift
- **Pause:** Esc
- **Mute:** M

## Win / Lose

- **Win:** Fill the **Beacon Charge** to 100%.
- **Lose:** **Assimilation** reaches 100%.

## Run locally

Because browsers block modules from `file://`, you need a small local web server.

Option A (Python):

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/` (if this folder is your server root)

## Build

This repo ships with a pre-built `dist/` folder, so you can embed it immediately.

If you change TypeScript and want to regenerate the build:

```bash
npm install
npm run build
```

## Standalone mode (no host)

If you open this without a host sending a postMessage `init`, add:

- `?standalone=1`

Example:

- `http://localhost:8080/index.html?standalone=1`

## Embedding contract (host <-> game)

This game is designed to be embedded in an iframe and controlled by a host app.

### Host -> Game

```js
{ type: "init", gameId, roomId, username, allowAbort, seed? }
```

### Game -> Host

```js
{ type: "outcome", outcome: "win"|"lose"|"abort", payload? }
```

`payload` contains:

- `score`
- `timeSurvivedMs`
- `maxAssimilation`
- `beaconCharge`
- `seed`
- `version`

## Static asset layout

For a typical server layout, place the compiled game bundle here:

```
/static/games/nanobot-drift/
  index.html
  styles.css
  dist/
    ...
```

(You can rename the folder if your host uses a different `game_id`, but make sure the host config points to that directory.)

## License

MIT (see `LICENSE`).
