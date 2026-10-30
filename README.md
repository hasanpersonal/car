# NEON DRIVE

A neon 3D browser racing game with solo practice, private multiplayer rooms,
quick match, realistic steering physics, nitro, shooting and special skills.

The game is designed to be played with the phone rotated sideways.

## Run the game locally

Because the game uses JavaScript modules, open it through a small local web
server instead of opening `index.html` directly as a file:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in a browser.

`index.html` stays in the repository root so the same layout also works on
GitHub Pages. All local file paths are relative.

## Project map

```text
.
├── index.html                  Page structure and script/style loading
├── README.md                   This guide
├── src/
│   ├── css/
│   │   ├── base.css            Page frame, container, canvas and flash
│   │   ├── screens.css         Start/waiting/game-over screens and menus
│   │   ├── hud.css             Score, speed, timer and nitro readouts
│   │   ├── controls.css        Steering wheel, pedals and ability buttons
│   │   ├── lobby-extras.css    Chat, quick-match and short-screen lobby rules
│   │   ├── responsive.css      Landscape layout adjustments
│   │   └── rotate-lock.css     Animated “rotate your device” screen
│   ├── js/
│   │   ├── game/
│   │   │   ├── config.js       Firebase settings and editable tuning values
│   │   │   └── main.js         Game rules, physics, input, audio and multiplayer
│   │   └── world/
│   │       ├── scene3d.js      three.js renderer, World and object syncing
│   │       ├── track.js        Road bends, hills and banking mathematics
│   │       ├── camera.js       Portrait/landscape chase-camera settings
│   │       ├── car3d.js        Procedural 3D Formula-style cars
│   │       ├── ribbon.js       Road/barrier strip-geometry helper
│   │       └── textures.js     Building, poster and skyline textures
│   └── vendor/
│       └── three.min.js        Local three.js library (do not edit)
└── tests/
    ├── verify.mjs              Full deterministic test suite
    ├── fakedb.mjs              In-memory Firebase used by tests
    ├── glstub.mjs              DOM/WebGL test doubles
    ├── probe.mjs               Camera-framing diagnostic tool
    ├── roadview.mjs            ASCII road-view diagnostic tool
    └── run.sh                  Test runner
```

## Where to edit common things

| What you want to change | File to open |
| --- | --- |
| Cruise/nitro/brake speed, traffic count, race time, physics tuning | `src/js/game/config.js` |
| Driving behavior, collisions, scoring, traffic AI, race flow | `src/js/game/main.js` |
| Multiplayer rooms, quick match or chat behavior | `src/js/game/main.js` |
| Steering-wheel and pedal behavior | `src/js/game/main.js` |
| Road bends, hills or banking strength | `src/js/world/track.js` |
| Camera height, distance, field of view or framing | `src/js/world/camera.js` |
| Buildings, lamp-pole posters or skyline artwork | `src/js/world/textures.js` |
| Car shape, colors, wheels or lights | `src/js/world/car3d.js` |
| Lobby and menu appearance | `src/css/screens.css` |
| HUD appearance | `src/css/hud.css` |
| Wheel, BOOST/BRAKE pedals and ability buttons | `src/css/controls.css` |
| Phone/landscape sizing | `src/css/responsive.css` |

## How the files connect

1. `index.html` loads the seven CSS files in the order shown above. Keep that
   order: later stylesheets intentionally refine earlier ones.
2. `index.html` loads Firebase, maps the `three` import to
   `src/vendor/three.min.js`, and starts `src/js/game/main.js`.
3. `main.js` owns the game rules and imports its settings from `config.js`.
4. `main.js` sends game state to `scene3d.js`, which only renders the world.
5. `scene3d.js` uses `track.js`, `camera.js`, `car3d.js`, `ribbon.js` and
   `textures.js` for its separate 3D responsibilities.

## Run the tests

```bash
cd tests
./run.sh
```

The suite runs the real game modules against deterministic DOM, WebGL,
Firebase and clock test doubles.
