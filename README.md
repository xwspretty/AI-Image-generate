# AI Image Generate

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/xwspretty/AI-Image-generate">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
  </a>
</p>

AI Image Generate 是一个部署在 Cloudflare Workers 上的轻量级 AI 生图工作台。它支持文生图、图生图、短描述生成提示词、多图并发生成、后台任务、本地历史、图床上传和两层访问控制，适合个人或小范围团队自用。

前端使用 React + Vite，后端使用 Cloudflare Workers。长任务由 Cloudflare Workflows 执行，任务状态和统计写入 D1。

## 项目来源

本项目基于 [y08lin4/AI-Image-generate](https://github.com/y08lin4/AI-Image-generate) fork 后二次开发，并在原有 AI 生图能力基础上做了面向个人自用部署的改造。当前仓库主要新增或调整了 Cloudflare Workers 部署、站点访问口令、服务端托管 API Key、空间密码隔离、后台任务、提示词生成、参考图复用、图床上传、本地历史和页面 UI 等功能。

## 功能概览

- 文生图和图生图，图生图支持最多 8 张参考图。
- 生成结果、本地历史图片可以继续作为参考图使用。
- 短描述生成完整提示词，支持复制或一键填入主提示词。
- 支持多张生成、并发控制、任务队列、超时设置。
- 支持比例和分辨率档位：自动、标准、2K、4K。
- 支持 Worker 流式代理、Worker 后台任务、浏览器直连三种请求方式。
- 支持服务端托管 API Key，使用者无需在页面里填写 API 配置。
- 支持站点访问口令，避免知道域名的人直接使用。
- 支持空间密码隔离云端任务，不同密码对应不同任务空间。
- 支持自动或手动上传生成图到 PiXhost 图床。
- 支持本地历史、历史图预览、复制、下载、加入参考图。
- 支持图片适配预览和全屏细节查看。
- 支持云端后台任务恢复、重试、今日生成数和累计生成数统计。
- 针对 401、403、413、429、502、524、CORS 等常见错误提供中文提示。

## 访问控制

项目有两层访问控制，作用不同：

| 名称 | 配置位置 | 作用 |
| --- | --- | --- |
| 站点访问口令 | Cloudflare Secret `SW_SITE_ACCESS_PASSWORD` | 进入网站前的门禁。未通过门禁时只能看到口令页，`/api/*` 会返回 401。 |
| 空间密码 | 用户在设置页输入 | 派生本地身份令牌，用于 Worker API 校验、云端任务归属隔离和任务同步。 |

站点访问口令推荐用 Cloudflare Secret 保存：

```bash
npx wrangler secret put SW_SITE_ACCESS_PASSWORD
```

`SW_SITE_ACCESS_PASSWORD` 兼容旧变量 `SITE_ACCESS_PASSWORD`，但新部署建议统一使用 `SW_` 前缀。

## 服务端托管 API

如果网站只给自己或少数人使用，推荐把上游 API 配置放到 Cloudflare Worker 环境变量里。这样使用者进入站点后无需填写 API URL、API Key 和模型名称，只需要关注提示词、参考图和生成参数。

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `SW_UPSTREAM_API_KEY` | Secret | 上游 API Key。 |
| `SW_UPSTREAM_BASE_URL` | 普通变量 | 上游 API 根地址，例如 `https://api.openai.com/v1`。 |
| `SW_MANAGED_API_ENABLED` | 普通变量或 Secret | 服务端托管开关。`true/1/on` 开启，`false/0/off` 关闭；未设置时有 URL 和 Key 就自动开启。 |
| `SW_IMAGE_MODEL` | 普通变量 | 默认生图模型，例如 `gpt-image-2`。 |
| `SW_PROMPT_MODEL` | 普通变量 | 默认提示词模型，例如 `gpt-5.4-mini`。 |

设置 API Key：

```bash
npx wrangler secret put SW_UPSTREAM_API_KEY
```

托管模式开启后：

- 设置页会隐藏 API URL、API Key 和模型选择。
- 浏览器直连会置灰不可选，避免 API Key 暴露到前端。
- Worker 流式代理和 Worker 后台任务会使用服务端环境变量里的 API 配置。
- 如需临时恢复手动配置，把 `SW_MANAGED_API_ENABLED` 设置为 `false`。

## 请求方式

### Worker 流式代理

```text
浏览器 -> /api/generate-stream -> Worker -> 上游图片接口
```

默认推荐。Worker 负责请求上游接口，可以绕过 CORS，并通过 SSE 在生成期间保活。多图生成时，完成一张返回一张。

### Worker 后台任务

```text
浏览器/App -> /api/background-tasks -> Worker -> Cloudflare Workflows -> 上游图片接口 -> PiXhost/D1
```

适合耗时较长或 App/WebView 切后台的场景。任务提交后由 Cloudflare Workflows 继续执行，前端回到页面时会同步云端任务状态。

后台任务会把成功结果上传到 PiXhost 并保存直链；如果图片超过 PiXhost 单张 10MB 限制，Worker 会临时把原图分片写入 D1，前端同步时再拉回本地保存历史。

### 浏览器直连

```text
浏览器 -> 上游 /images/generations 或 /images/edits
```

链路最短，API Key 不经过 Worker，但要求上游支持浏览器 CORS。服务端托管 API Key 时不可使用浏览器直连。

## 图片接口约定

项目面向 OpenAI 风格图片接口，当前默认模型为 `gpt-image-2`。

| 模式 | 上游接口 |
| --- | --- |
| 文生图 | `POST /v1/images/generations` |
| 图生图 | `POST /v1/images/edits` |

API URL 请填写根地址，例如：

```text
https://api.example.com/v1
```

如果误填完整接口地址，例如 `https://api.example.com/v1/images/generations`，Worker 会自动规整为 `https://api.example.com/v1` 后再拼接正确接口。

图生图会以 `image[]` 字段追加到 `multipart/form-data`。单张参考图限制 12MB，总大小限制 50MB。

## 比例和分辨率

| 比例 | 标准 | 2K | 4K |
| --- | --- | --- | --- |
| `1:1` | `1024x1024` | `2048x2048` | `2880x2880` |
| `2:3` | `1024x1536` | `1344x2016` | `2336x3504` |
| `3:2` | `1536x1024` | `2016x1344` | `3504x2336` |
| `3:4` | `768x1024` | `1536x2048` | `2448x3264` |
| `4:3` | `1024x768` | `2048x1536` | `3264x2448` |
| `9:16` | `1008x1792` | `1152x2048` | `2160x3840` |
| `16:9` | `1792x1008` | `2048x1152` | `3840x2160` |

说明：

- 分辨率和比例都选自动时，不向上游传 `size` 参数。
- 分辨率选自动、比例选具体值时，会按标准档尺寸传给接口。
- 分辨率选标准、2K 或 4K 时，比例必须选择具体值。
- 4K 生成更慢，部分上游线路可能更容易出现 502，遇到时建议重试或切换线路。

## PiXhost 图床

开启自动上传后，成功生成的图片会上传到 PiXhost。上传成功后可以复制图片直链 URL。

如果关闭自动上传，仍可以在单张图片悬浮操作里手动上传。上传失败后可以重试。已上传成功的 URL 会写入本地历史，刷新后仍可复制。

注意：

- PiXhost 是第三方图床，私密图片不建议开启自动上传。
- PiXhost 单张图片最大 10MB，4K PNG 可能超过限制。
- App/WebView 下展示、下载、复制图床图片会走 Worker 图片代理，减少直链跳转和 CORS 问题。

## Cloudflare 资源

项目使用这些 Cloudflare 能力：

| 资源 | 用途 |
| --- | --- |
| Workers | API 代理、访问门禁、图片代理、静态资源托管。 |
| Static Assets | 托管 Vite 构建后的前端资源。 |
| D1 | 保存后台任务状态、结果摘要、统计数据和超大图片临时分片。 |
| Workflows | 执行后台生图任务。 |
| Secrets / Variables | 保存站点口令、上游 API Key、模型和开关。 |

## 环境变量

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `SW_SITE_ACCESS_PASSWORD` | Secret | 空 | 站点访问口令。为空时不启用门禁。 |
| `SW_UPSTREAM_API_KEY` | Secret | 空 | 服务端托管模式使用的上游 API Key。 |
| `SW_UPSTREAM_BASE_URL` | 普通变量 | `https://api.openai.com/v1` | 服务端托管模式使用的 API 根地址。 |
| `SW_MANAGED_API_ENABLED` | 普通变量或 Secret | 空 | 托管开关。未设置时根据 URL 和 Key 自动判断。 |
| `SW_IMAGE_MODEL` | 普通变量 | `gpt-image-2` | 默认生图模型。 |
| `SW_PROMPT_MODEL` | 普通变量 | `gpt-5.4-mini` | 默认提示词模型。 |
| `ALLOW_HTTP_API` | 普通变量 | `true` | 是否允许 HTTP API 地址。 |
| `ALLOW_PRIVATE_HOSTS` | 普通变量 | `false` | 是否允许代理内网、localhost、metadata 地址。 |

## 本地开发

安装依赖：

```bash
npm install
```

只启动前端：

```bash
npm run dev
```

完整测试 Worker：

```bash
npm run worker:dev
```

纯 Vite 开发只跑前端，Worker API 不会生效。需要测试 `/api/generate-stream`、后台任务、D1、Workflows 时，请使用 Worker 开发模式。

## 部署到 Cloudflare

1. 创建 D1 数据库：

```bash
npx wrangler d1 create ai-image-generate
```

把返回的 `database_id` 填入 `wrangler.jsonc`。

2. 应用 D1 迁移：

```bash
npx wrangler d1 migrations apply ai-image-generate --remote
```

3. 设置 Secret：

```bash
npx wrangler secret put SW_SITE_ACCESS_PASSWORD
npx wrangler secret put SW_UPSTREAM_API_KEY
```

4. 按需修改 `wrangler.jsonc` 中的域名、D1 ID、模型和普通变量。

5. 部署：

```bash
npm run worker:deploy
```

`worker:deploy` 使用 `wrangler deploy --keep-vars`，会尽量保留 Cloudflare 控制台里维护的变量和 Secret，避免部署时覆盖线上配置。

## 一键部署

点击 README 顶部的 Deploy to Cloudflare 按钮可以从 GitHub 仓库创建 Worker。

注意：一键部署依赖 GitHub 上的当前仓库内容。首次使用前，需要先把代码提交并推送到 `https://github.com/xwspretty/AI-Image-generate`。D1、Workflows、Secret 和自定义域名仍建议在 Cloudflare 控制台或 Wrangler 中核对配置。

## 提交前检查

```bash
npm run build
git diff --check
git status -sb
```

## 安全说明

- 不要把 API Key、站点访问口令写入源码或提交到 GitHub。
- 浏览器手动配置模式下，API URL 和 API Key 保存在浏览器本地或会话存储中。
- 服务端托管模式下，API Key 保存在 Cloudflare Secret 中，前端不会看到 Key。
- Worker 不把 API Key 写入 D1，也不主动打印请求体。
- 后台任务执行时会把 API Key 传给 Cloudflare Workflow 实例使用，但不会写入 D1。
- 空间密码不会明文保存；前端派生访问令牌，Worker/D1 只保存归属 hash。
- 默认阻止代理 localhost、内网 IP 和 metadata 地址。
- 自动上传会把图片发送到第三方图床，私密图片请谨慎使用。

## 许可证

当前仓库未声明开源许可证。如需公开给他人复用，建议补充 LICENSE 文件。
