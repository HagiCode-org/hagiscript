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

`npm-sync` 会根据 JSON manifest，把指定 Node.js 运行时中的 npm 全局包版本同步到约束范围内。它始终使用 `--runtime` 解析出的 `npm` 可执行文件，不会使用或修改当前 shell `PATH` 中的 npm。

```bash
hagiscript npm-sync --runtime /opt/hagiscript/node --manifest ./manifest.json
```

Manifest 结构：

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
Manifest validated: ./manifest.json (2 packages)
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
Packages: 2
No-op: 1
Changed: 1
```

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

- `ci.yml` 使用 `npm ci` 安装依赖，并执行 lint、格式检查、测试、构建和包内容校验。
- `npm-publish.yml` 在 `main` 分支发布唯一预发布版本到 `dev` dist-tag。
- `npm-publish.yml` 也会在非草稿、非 prerelease 的 GitHub Release 发布时，校验 `vX.Y.Z` 标签并发布到 `latest` dist-tag。
- `release-drafter.yml` 通过 `.github/release-drafter.yml` 维护分类清晰的发布草稿。

首次发布前，需要先确保 npm 上已经存在组织或用户 scope `hagicode`，并且 `@hagicode/hagiscript` 已授权当前发布主体。GitHub Actions 发布时，需要在 npm trusted publishing 中配置仓库 `HagiCode-org/hagiscript` 和 workflow `.github/workflows/npm-publish.yml`。如果 scope 不存在，或 workflow 身份无权在该 scope 下创建包，npm 会在最后的 `PUT https://registry.npmjs.org/@hagicode%2fhagiscript` 发布请求中返回 `E404 Not Found`。

重试失败的发布前，先运行发布前置检查：

```bash
npm run publish:check-prereqs
```

本地手动发布时，先登录一个有权发布到 `@hagicode` scope 的 npm 账号，再直接执行普通 `npm publish`。
