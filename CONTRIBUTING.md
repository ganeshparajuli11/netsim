# Contributing to OpenNetSim

Thanks for helping people learn networking.

## Ground rules

- **Clean room only.** Don't copy code, assets, text or file formats from proprietary simulators, and don't decompile them. Implement from RFCs and IEEE standards, vendor-neutral textbooks, and your own observation of how protocols behave.
- **Engine stays DOM-free.** Everything in `src/engine` and `src/cli` must run under Node so it can be tested.
- **Every feature gets a test.** Add a scenario to `tests/`. Build a small topology, drive it through the CLI helpers (`ios(device).run(...)`, `cmd(pc).run(...)`) and assert on behaviour.
- **Explain decisions.** When a device does something with a packet, call `this.explain('…')`. That text is what learners read in the packet inspector.

## Adding a CLI command

Commands are declared in `src/cli/ios.js`:

```js
C.add(['config-if'], ['ip address <ip> <mask>'], function ([ip, mask]) { /* ... */ });
```

The placeholders are `<ip>`, `<mask>`, `<n>`, `<word>`, `<if>` (an interface name such as `g0/0`) and `<line>` (the rest of the line). Literals can list alternatives with `a|b`. Abbreviations, ambiguity errors, `?` help and Tab completion all come for free.

## Adding a lab

Add an entry to `LABS` in `src/ui/labs.js` with `build(net)`, `guide` (HTML) and `checks`. Then add a solution to `tests/labs.test.js`. The test makes sure the lab starts unsolved and can be completed.

## Running

```bash
npm test
npm start
npm run build
```
