# @3drx/pi-reasoning-level

A Pi extension that adds a model-aware `/reasoning` slash command for viewing and changing the current reasoning effort.

The command uses Pi's model metadata to expose only levels supported by the selected model. When the model changes, argument completions update automatically.

## Commands

```text
/reasoning          # choose from the current model's supported levels
/reasoning status   # show the model, current level, and supported levels
/reasoning high     # set a supported level directly
/reasoning off      # disable reasoning when the model supports it
```

Direct arguments support slash-command completion. Unsupported levels are rejected with the levels available for the current model.

## Model support

The extension uses `getSupportedThinkingLevels()` from `@earendil-works/pi-ai`, the same model-aware helper Pi uses internally.

Support is determined from the selected model's `reasoning` and `thinkingLevelMap` metadata:

- non-reasoning models expose only `off`
- standard levels are available unless explicitly mapped to `null`
- extended levels are available only when the model explicitly maps them
- sparse support is allowed, such as a model supporting `high` and `max` but not `xhigh`

The result is only as accurate as the provider's model catalog. Custom providers should describe unsupported or provider-specific levels with `thinkingLevelMap`.

## Local development

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-reasoning-level typecheck
pi -e ./packages/reasoning-level/src/index.ts
```

Or load the whole monorepo Pi package:

```bash
pi -e /absolute/path/to/pi-extensions-lab
```
