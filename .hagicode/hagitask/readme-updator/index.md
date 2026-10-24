---
public: true
multilingual: false
style: product
---

# README requirements

## Product focus

- Present `@hagicode/hagiscript` as the CLI that installs and operates a managed HagiCode runtime: it sets up managed Node.js and .NET runtimes, installs and runs the released backend server, manages the `code-server` service and syncs managed npm tools from a manifest.
- Address users and operators who install HagiCode locally or on a host. This is a developer-facing CLI, so commands, flags and manifests are part of the product.
- Open with the install and quick start commands, then describe what Hagiscript manages and the day-to-day lifecycle commands.

## Required content

- Keep the install, quick start, what Hagiscript manages, runtime basics and install workflow, server install, lifecycle and configuration, code_server commands, managed npm tool sync, end-to-end flow, useful flags and license sections.
- Command names and flags must match `src/` and the CLI help; keep the Node.js 24+ requirement consistent with `package.json`.
- Keep the license statement consistent with `LICENSE`.

## Exclusions

- Exclude npm tokens, secret values, internal hosts, machine-specific paths and private links.
- Keep repository maintenance instructions out of the README: repository layout, internal architecture, CI, build internals and contribution workflow.
- Do not list features the repository does not show.
