#!/usr/bin/env node

import process from "node:process"

const componentName = process.env.HAGISCRIPT_RUNTIME_COMPONENT_NAME ?? "unknown"
process.stderr.write(`intentional failure for ${componentName}\n`)
process.exit(17)
