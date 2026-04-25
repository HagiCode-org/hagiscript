# Hagiscript

`@hagicode/hagiscript` 是 Hagiscript 语言工具链的作用域 npm 包基础工程。本次初始化只提供最小运行能力：版本元数据、基础运行时信息 API，以及一个可构建、可测试、可打包、可发布的 CLI 占位入口。

## 安装假设

- 需要 Node.js 20 或更高版本。
- 该独立仓库使用 npm 作为包管理器。
- npm 包名为 `@hagicode/hagiscript`。
- GitHub Actions 发布使用 `npm publish --provenance`。本地手动发布时，应直接使用普通 `npm publish`，除非当前环境本身就是受支持的 trusted publishing 环境。

## 使用方式

先从 npm 安装该包：

```bash
npm install @hagicode/hagiscript
```

安装后的 CLI 命令仍然是 `hagiscript`。

开发时运行 CLI：

```bash
npm run dev -- --help
npm run dev -- info
npm run dev -- install-node --target .tmp/node-runtime
npm run dev -- check-node --target .tmp/node-runtime
npm run dev -- npm-sync --runtime .tmp/node-runtime --manifest manifest.json
```

构建后运行编译产物：

```bash
npm run build
node dist/cli.js --version
node dist/cli.js info
node dist/cli.js install-node --target .tmp/node-runtime
node dist/cli.js check-node --target .tmp/node-runtime
node dist/cli.js npm-sync --runtime .tmp/node-runtime --manifest manifest.json
```

### 托管 Node.js 运行时命令

`install-node` 会从 `https://nodejs.org/dist` 下载官方 Node.js 归档包，解压到目标目录，并在成功前验证 `node` 与 `npm` 都可执行。

```bash
hagiscript install-node --target /opt/hagiscript/node
hagiscript install-node --target /opt/hagiscript/node20 --version 20
hagiscript install-node --target /opt/hagiscript/lts --version lts
```

省略 `--version` 时，Hagiscript 默认安装最新可用的 Node.js 22 版本。支持的选择器包括 `lts`、`latest`、`current`、类似 `22` 的主版本号、类似 `22.12.0` 的精确版本，以及类似 `v22.12.0` 的带 `v` 精确版本。

目标路径必须不存在或为空目录。Hagiscript 会拒绝安装到非空目标目录，也不会删除已有用户文件。安装期间，临时 staging 文件会创建在目标目录旁边，并在成功或失败后清理。

成功输出示例：

```text
Installing Node.js 22 into /opt/hagiscript/node
Download progress: 100%
Node.js runtime installed successfully.
Target: /opt/hagiscript/node
Node.js: v22.12.0
npm: 10.9.0
node: /opt/hagiscript/node/bin/node
npm: /opt/hagiscript/node/bin/npm
```

`check-node` 会验证已有运行时目录；只有 `node --version` 和 `npm --version` 都成功时才以退出码 `0` 结束。

```bash
hagiscript check-node --target /opt/hagiscript/node
```

有效运行时输出示例：

```text
Node.js runtime is valid.
Target: /opt/hagiscript/node
Node.js: v22.12.0
npm: 10.9.0
node: /opt/hagiscript/node/bin/node
npm: /opt/hagiscript/node/bin/npm
```

无效运行时会以非零退出码结束，并输出失败原因：

```text
Node.js runtime is invalid.
Target: /opt/hagiscript/node
Reason: missing executable
```

### npm 全局包同步

`npm-sync` 会根据 JSON manifest，把 HagiScript 托管 Node.js 运行时中的 npm 全局包版本同步到约束范围内。默认情况下，它会验证或安装 `~/.hagiscript/node-runtime`，并使用该运行时内的 `npm`；它不会使用或修改当前 shell `PATH` 中的 npm。已有自动化仍可继续传入 `--runtime` 使用显式运行时目录。

```bash
hagiscript npm-sync --manifest ./manifest.json
hagiscript npm-sync --runtime /opt/hagiscript/node --manifest ./manifest.json
hagiscript npm-sync --manifest ./manifest.json --registry-mirror https://registry.npmmirror.com/
hagiscript npm-sync --manifest ./manifest.json --registry-mirror https://registry.npmmirror.com/ --mirror-only
```

兼容模式 manifest 结构：

```json
{
  "packages": {
    "<npm-package-name>": {
      "version": "<semver range>",
      "target": "<optional npm install selector>"
    }
  }
}
```

必填的 `version` 字段使用 package.json 风格的 semver 范围，例如 `^1.2.0`、`>=1.0.0 <2.0.0` 或 `1.0.0 || 2.0.0`。可选的 `target` 字段用于指定实际执行 `npm install -g` 时使用的选择器；如果省略，Hagiscript 会安装 `<package>@<version>`。

可选的顶层 `registryMirror` 字段用于指定 npm 检测与安装命令所使用的镜像地址，必须是非空的绝对 `http:` 或 `https:` URL。配置后，Hagiscript 会先对 `npm list -g --depth=0 --json` 和 `npm install -g <package>@<selector>` 追加 `--registry <registryMirror>` 并优先走镜像；如果镜像对应的 npm 命令失败，则会把同一条 inventory 或 install 命令自动重试一次到官方源 `https://registry.npmjs.org/`。这个自动降级只作用于 npm inventory 与包变更命令，不会重试运行时校验、manifest 校验或同步计划计算。

产品托管的工具同步可使用扩展后的 `tools` manifest。必选工具始终会按 `src/runtime/tool-sync-catalog.config.json` 中的内部固定版本纳入同步：OpenSpec skills（`skills@1.5.1`）、OmniRoute（`omniroute@3.6.9`）和 code-server（`code-server@4.117.0`）。可选 agent CLI 同步需要显式启用；如果传入内置 CLI 或自定义 npm 包选择，它们会被加入同步。

```json
{
  "tools": {
    "optionalAgentCliSyncEnabled": true,
    "selectedOptionalAgentCliIds": ["codex", "claude-code", "fission-openspec", "opencode"],
    "customAgentClis": [
      {
        "packageName": "@scope/agent-cli",
        "version": "^1.0.0"
      }
    ]
  }
}
```

首批内置可选 agent CLI ID 为 `codex`（`@openai/codex@0.125.0`）、`claude-code`（`@anthropic-ai/claude-code@2.1.119`）、`fission-openspec`（`@fission-ai/openspec@1.3.1`）、`qoder`（`@qoder-ai/qodercli@0.1.48`）和 `opencode`（`opencode-ai@1.14.24`）。这些内置包版本固定在 `src/runtime/tool-sync-catalog.config.json` 中。HagiScript 会在执行 `npm list` 或 `npm install` 前校验未知工具 ID、npm 包名和版本选择器。

使用 `--registry-mirror <url>` 可以在单次运行中覆盖 manifest 中的镜像地址，优先级依次为 CLI 覆盖、manifest 的 `registryMirror`、以及 npm 默认注册表行为。如果 CLI 与 manifest 都没有提供镜像，Hagiscript 就不会附加 `--registry`，现有的 npm 默认设置、`.npmrc` 或环境变量行为会保持不变。

如果某次同步必须严格停留在镜像源且不能自动切回官方源，请添加 `--mirror-only`。省略该选项时，只要配置了镜像，Hagiscript 默认就会在镜像失败后自动回退到 `https://registry.npmjs.org/` 一次。

简单的产品托管请求也可以直接通过 CLI 选项传入可选 CLI，而不必先写 manifest：

```bash
hagiscript npm-sync --selected-agent-cli codex
hagiscript npm-sync --selected-agent-cli codex --custom-agent-cli @scope/agent-cli@^1.0.0
```

openspec 和 skills 工具同步示例：

```json
{
  "packages": {
    "@openspec/cli": {
      "version": "^1.0.0"
    },
    "@hagicode/skills": {
      "version": ">=0.5.0 <1.0.0",
      "target": "0.5.4"
    }
  }
}
```

执行时，Hagiscript 会先验证 manifest 和运行时，再执行任何 npm install 操作；它会用 `/opt/hagiscript/node/bin/npm list -g --depth=0 --json` 检测全局包，生成 no-op、install、upgrade、downgrade 或 sync 计划，然后只对需要变更的包执行 `npm install -g <package>@<selector>`。

输出示例：

```text
Manifest validated: ./manifest.json (2 packages, mode=packages)
Registry mirror: https://registry.npmmirror.com/
Fallback policy: auto
Runtime validated: /opt/hagiscript/node
node: /opt/hagiscript/node/bin/node (v22.12.0)
npm: /opt/hagiscript/node/bin/npm (10.9.0)
Detected global packages: 4
Plan: @openspec/cli noop installed=1.0.2 required=^1.0.0 selector=@openspec/cli@^1.0.0
Skip: @openspec/cli already satisfies range
Plan: @hagicode/skills upgrade installed=0.4.0 required=>=0.5.0 <1.0.0 selector=@hagicode/skills@0.5.4
Install: @hagicode/skills using @hagicode/skills@0.5.4
Synced: @hagicode/skills (upgrade)
npm-sync complete.
Runtime: /opt/hagiscript/node
Manifest: ./manifest.json
Mode: packages
Registry mirror: https://registry.npmmirror.com/
Fallback policy: auto
Fallback used: no
Packages: 2
No-op: 1
Changed: 1
```

如果触发了回退，Hagiscript 会在执行期间输出 `Fallback used: ...`，并在最终摘要中记录 `Fallback detail: ...`，这样 CI 或桌面端自动化就能明确知道哪个镜像失败了、是否切到了官方源，以及官方源重试是否成功。

在 ESM 项目中使用库 API：

```ts
import { createRuntimeInfo, getPackageMetadata } from "@hagicode/hagiscript";

console.log(getPackageMetadata());
console.log(createRuntimeInfo());
```

## 开发命令

所有命令都应在 `repos/hagiscript/` 下执行：

```bash
npm install
npm run lint
npm run format:check
npm test
npm run build
npm run pack:check
```

其他常用命令：

```bash
npm run clean
npm run format
npm run test:watch
npm run publish:prepare-dev-version
npm run publish:verify-release -- v0.1.0
```

## 构建输出

`npm run build` 会使用严格的 NodeNext TypeScript 配置编译到 `dist/`。预期入口文件包括：

- `dist/index.js`
- `dist/index.d.ts`
- `dist/index.js.map`
- `dist/cli.js`
- `dist/cli.d.ts`
- `dist/cli.js.map`

`package.json` 的 `exports` 字段指向 `dist/index.js` 和 `dist/index.d.ts`。发布到 npm 后的包名是 `@hagicode/hagiscript`，`bin.hagiscript` 指向 `dist/cli.js`。

## 包内容校验

`npm run pack:check` 会执行 dry-run 打包检查。如果缺少必要运行文件，或错误包含源码测试、脚本、覆盖率、临时目录等只应存在于开发环境的文件，脚本会失败。

## 发布自动化

GitHub Actions 提供三类自动化流程：

- `ci.yml` 使用 `npm ci` 安装依赖，并执行测试、构建和包内容校验。
- `npm-publish.yml` 在 `main` 分支解析唯一预发布版本，用 `npm version --no-git-tag-version` 同步 `package.json` 和 `package-lock.json`，再发布到 `dev` dist-tag。
- `npm-publish.yml` 也会在非草稿、非 prerelease 的 GitHub Release 发布时，校验 `vX.Y.Z` 标签格式，拒绝早于仓库基础版本的标签，并用同样方式写入稳定版本再发布到 `latest` dist-tag。
- `release-drafter.yml` 通过 `.github/release-drafter.yml` 维护分类清晰的发布草稿。

首次发布前，需要先确保 npm 上已经存在组织或用户 scope `hagicode`，并且 `@hagicode/hagiscript` 已授权当前发布主体。GitHub Actions 发布时，需要在 npm trusted publishing 中配置：package `@hagicode/hagiscript`、owner `HagiCode-org`、repository `hagiscript`、workflow filename `npm-publish.yml`。不要把 workflow filename 填成完整路径；如果 npm 表单有 environment 字段，除非 workflow job 显式声明了 environment，否则保持为空。如果 scope 不存在，或 workflow 身份无权在该 scope 下创建包，npm 会在最后的 `PUT https://registry.npmjs.org/@hagicode%2fhagiscript` 发布请求中返回 `E404 Not Found`。

重试失败的发布前，先运行发布前置检查：

```bash
npm run publish:check-prereqs
```

本地手动发布时，先登录一个有权发布到 `@hagicode` scope 的 npm 账号，再直接执行普通 `npm publish`。
