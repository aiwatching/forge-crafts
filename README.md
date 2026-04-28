# forge-crafts

Public registry for [Forge](https://github.com/aiwatching/forge) **Crafts** —
project-scoped mini-apps (a tab + optional API server) that anyone can install
into their own Forge project.

## What lives here

```
forge-crafts/
├── registry.json     # the manifest Forge fetches
├── schema.json       # JSON Schema for registry.json
├── <craft-name>/
│   ├── craft.yaml    # name, version, requires, tags
│   ├── ui.tsx        # React component (default export)
│   ├── server.ts     # optional API routes
│   └── README.md     # what this craft does
└── ...
```

`registry.json` shape:

```json
{
  "version": 1,
  "crafts": [
    {
      "name": "api-dashboard",
      "displayName": "📊 API Dashboard",
      "description": "OpenAPI endpoint browser",
      "version": "0.1.0",
      "author": "github-handle",
      "tags": ["openapi", "java"],
      "requires": {
        "hasFile": ["docs/openapi.json"],
        "hasGlob": ["**/*.java"]
      },
      "files": ["craft.yaml", "ui.tsx", "server.ts", "README.md"]
    }
  ]
}
```

`requires` is OR-logic — at least one matcher must match for Forge to consider
the craft compatible with a project.

## Installing a craft

Open any project in Forge → `🛠 Crafts ▾` dropdown → `🛒 Marketplace`. Forge
filters this registry to crafts compatible with the current project.

## Publishing a craft

Don't write files here by hand. In Forge, open the craft you want to publish
and click the **📦** button — Forge generates a PR against this repo via
GitHub's auto-fork flow. The maintainer will review and merge.

Forge documentation:
[`lib/help-docs/15-crafts.md`](https://github.com/aiwatching/forge/blob/main/lib/help-docs/15-crafts.md)
and the [`craft-builder` skill](https://github.com/aiwatching/forge/blob/main/lib/forge-skills/craft-builder.md)
for the SDK + manifest reference.

## Private / team registries

Fork this repo and point your team's Forge instances at the fork by setting
`craftsRepoUrl` in `~/.forge/data/settings.yaml`:

```yaml
craftsRepoUrl: https://raw.githubusercontent.com/myteam/forge-crafts/main
```

## License

Each craft retains its own license (in its folder's `README` or a `LICENSE`
file). Registry metadata in this repo is MIT.
