# hagiscript

`hagiscript` 是 Hagiscript 语言工具链的 npm 包基础工程。本次初始化只提供最小运行能力：版本元数据、基础运行时信息 API，以及一个可构建、可测试、可打包、可发布的 CLI 占位入口。

## 安装假设

- 需要 Node.js 20 或更高版本。
- 该独立仓库使用 npm 作为包管理器。
- 初始包名为 `hagiscript`。如果后续 npm 包名可用性要求改为作用域包，需要同步更新 `package.json`、发布工作流和文档。
- npm 发布需要配置支持 provenance 的 GitHub Actions trusted publishing，或配置兼容 `npm publish --provenance` 的 npm token。

## 使用方式

开发时运行 CLI：

```bash
npm run dev -- --help
npm run dev -- info
```

构建后运行编译产物：

```bash
npm run build
node dist/cli.js --version
node dist/cli.js info
```

在 ESM 项目中使用库 API：

```ts
import { createRuntimeInfo, getPackageMetadata } from "hagiscript";

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

`package.json` 的 `exports` 字段指向 `dist/index.js` 和 `dist/index.d.ts`，`bin.hagiscript` 指向 `dist/cli.js`。

## 包内容校验

`npm run pack:check` 会执行 dry-run 打包检查。如果缺少必要运行文件，或错误包含源码测试、脚本、覆盖率、临时目录等只应存在于开发环境的文件，脚本会失败。

## 发布自动化

GitHub Actions 提供三类自动化流程：

- `ci.yml` 使用 `npm ci` 安装依赖，并执行 lint、格式检查、测试、构建和包内容校验。
- `npm-publish.yml` 在 `main` 分支发布唯一预发布版本到 `dev` dist-tag。
- `npm-publish.yml` 也会在非草稿、非 prerelease 的 GitHub Release 发布时，校验 `vX.Y.Z` 标签并发布到 `latest` dist-tag。
- `release-drafter.yml` 通过 `.github/release-drafter.yml` 维护分类清晰的发布草稿。

首次发布前，需要在 npm 和 GitHub 仓库侧配置 trusted publishing，或按注册表策略配置所需密钥。
