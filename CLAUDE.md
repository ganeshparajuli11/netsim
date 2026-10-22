# Notes for AI contributors (and humans in a hurry)

OpenNetSim is a clean-room, browser-based network simulator for learning. Read README.md, CONTRIBUTING.md and docs/ARCHITECTURE.md before changing code.

## Hard rules

- **Clean room.** Never copy, decompile or imitate code, icons, text or file formats from Cisco Packet Tracer or any other proprietary product. Work from RFCs and IEEE standards and from widely documented CLI behaviour. Don't use Cisco names or logos in the UI.
- **No runtime dependencies.** Plain ES modules, no framework. Dev dependencies only when unavoidable (esbuild is the only one).
- **Engine and CLI stay DOM-free**, so they run under `node --test`.
- **Every feature ships with tests** in `tests/`. Use the helpers in `tests/helpers.js`: `ios(device).run('…')` and `cmd(pc).run('…', net)`. New labs need a solution in `tests/labs.test.js`.
- **Never weaken or delete an existing test to make a change pass.** If a test is wrong, fix it in its own clearly explained commit.
- **Explain packet decisions** with `this.explain('…')` so the simulation inspector can teach.
- **Keep saved files loadable.** Old `.onsim.json` files must still open. Add new config fields with defaults.
- **UI copy** is plain, sentence case and active voice. Keep the existing visual style (tokens in `src/ui/styles.css`). Support both light and dark themes and narrow screens.

## Workflow for the daily automated run

1. Take the first unchecked item in ROADMAP.md that isn't marked `(claimed: …)`.
2. Work on a branch named `auto/<short-slug>`.
3. Implement it, with tests. Run `npm test` and `npm run build`. Both must pass.
4. If the change touches the UI, load the page in headless Chromium (Playwright is available) and check that there are no console errors.
5. Tick the item in ROADMAP.md (move it to Done) and add a CHANGELOG.md entry.
6. Open a pull request that explains what was built and how it was tested, wait for CI, and squash-merge it when CI is green.
7. If the item can't be finished in one run, split it into smaller roadmap items, build the first piece, and merge only that piece.
