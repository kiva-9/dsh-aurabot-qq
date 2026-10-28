# 开发说明

本仓库是 DeepSeek Harness（DSH）插件，使用 JavaScript ES Modules。宿主入口是 `src/host.js`，面板入口是 `client/client.js`，加载声明在 `cordis.patch.yml`。

## 初始化

开发使用 `.nvmrc` 中的 Node.js 24.19.0；插件声明的最低运行版本仍为 Node.js 22.13.0。已经有兼容 Node.js 的环境可以直接安装依赖，有 nvm 的环境先执行 `nvm install` 和 `nvm use`。

```bash
npm ci
npm test
```

提交 `package-lock.json`，让后续开发使用相同的依赖版本。只有需要调整依赖时才运行 `npm install`，并一起审查锁文件的变化。目前插件没有第三方运行依赖。

本项目没有独立的 `npm run dev` 或构建步骤。面板依赖 DSH 提供的服务与界面插槽，需要在 DSH 中查看实际效果。

## 在 Windows 上接续开发

安装 Git、Node.js 24.19.0 和 DSH 桌面版。首次下载时在 PowerShell 中执行：

```powershell
git clone https://github.com/kiva-9/dsh-aurabot-qq.git
cd dsh-aurabot-qq
node --version
npm.cmd ci
npm.cmd test
```

重构方案、审计材料和重构进度放在仓库根目录的 `.refactor/`，这个目录被 `.gitignore` 忽略，只在本机保存。换机器接续时需要自己复制过去；最初版本可从 Git 历史 `e584093` 的 `docs/` 里取回。

若使用 nvm-windows，显式执行 `nvm install 24.19.0` 和 `nvm use 24.19.0`；不要依赖它自动读取 `.nvmrc`。上面的 `npm.cmd` 可避免 PowerShell 选择 `npm.ps1` 时受到脚本执行策略影响，无需为此修改系统执行策略。

代码、说明和锁文件随 Git 获取。真实 QQ 登录状态、API 密钥、DSH 配置、运行数据和云端临时目录不在仓库里，需要在本机配置。审计使用的是合成数据；仓库中的结果文件用于说明已验证的行为，不代表本机已经完成真实服务联调。

## 测试与联调

```bash
# 全部现有测试
npm test

# 只测试正在修改的功能，例如按聊天选模型
node --test test/chat-model.test.js

# 检查待提交补丁的空白问题
git diff --check
```

测试使用 Node.js 自带的测试运行器。端到端测试由 `test/helpers/fake-dsh.js` 和 `test/helpers/mock-onebot.js` 提供模拟 DSH、模型和 OneBot 网关；这些模拟链路不需要真实 QQ 账号或模型 API Key。

初始化时，在 Linux + Node.js 24.19.0 上运行上游提交 `6acbf9d` 的 272 项测试：269 项通过，3 项失败。两项失败来自端到端测试依赖 Windows 语音服务，另一项来自翻唱安装测试依赖 Windows 路径和 C 盘。这是初始化基线。删除 QQ 空间与抖音之后剩 187 项；在 Windows 上 185 项通过，失败的 2 项是依赖中文 Windows 语音（Huihui）的端到端用例，本机没装中文语音时会超时。

Linux 云端用于代码开发和自动化测试。真实 QQ 登录、SnowLuma 注入、Windows 语音和桌面交互需要在 Windows + DSH 桌面版中联调；自动化测试通过不代表这些真实服务已经验证。

在 Windows 上检出待测试分支后，可以把本地仓库安装到桌面 profile。把下面的路径改成本机仓库的实际路径，安装后重启 DSH：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\dev\dsh-aurabot-qq"
```

配置、人格和记忆默认放在 `~/.dsh/plugins-data/aurabot/`。需要隔离联调数据时，在启动 DSH 的进程环境中设置 `AURABOT_DATA_DIR`；会话工作目录可用 `AURABOT_WORKSPACE` 指定。仓库中的 `.local/` 和 `.env*` 已忽略，但插件不会自动读取 `.env` 文件。测试会为需要持久化数据的用例设置临时目录。

## Git 工作流

- `origin`：自己的 fork，`https://github.com/kiva-9/dsh-aurabot-qq.git`。
- `upstream`：原项目，`https://github.com/accomplish07zrh-eng/dsh-aurabot-qq.git`。

首次在新机器检出时，如果还没有 `upstream`，执行：

```bash
git remote add upstream https://github.com/accomplish07zrh-eng/dsh-aurabot-qq.git
git config --local remote.pushDefault origin
git config --local push.default current
```

每项功能使用单独的分支；以下示例从自己 fork 的主分支开始：

```bash
git fetch origin
git switch -c codex/feature-name origin/main
```

提交前跑相关测试，并检查 `git diff` 和 `git diff --check`。提交时显式选择修改的文件，再推送当前分支：

```bash
git add <修改的文件>
git commit -m "feat: 描述功能变化"
git push -u origin HEAD
```

需要吸收原作者的新改动时，先在工作区干净的情况下检查差异，再合并到当前开发分支：

```bash
git fetch upstream
git log --oneline HEAD..upstream/main
git diff HEAD...upstream/main
git merge upstream/main
npm ci
npm test
```

## 常用代码位置

| 要修改的内容 | 入口 |
| --- | --- |
| 面板布局、表单、交互 | `client/client.js` |
| 宿主初始化、面板接口 | `src/host.js` |
| 默认配置与配置归一化 | `src/core/config.js` |
| 消息处理、权限、群聊策略 | `src/chat/` |
| 内置功能模块 | `src/modules/` |
| 扩展模块接口 | `src/modules/API.md` |
| 默认人格 | `personas/dafeiyu.md` |
| 插件与会话预设注册 | `cordis.patch.yml` |
| 更新检测 | `src/core/update.js` |

## 准备发布独立版本时

目前保留了上游的插件标识和发布配置。正式发布修改版时，需要一起检查包名、`cordis.patch.yml` 引用、仓库地址、安装说明和更新来源，设计好原版数据的迁移方式。`package.json` 中的 `private: true` 会阻止 npm 发布；确定使用 npm 分发后再调整。保留 MIT 许可证与原作者版权声明，并在说明中注明修改版的来源和差异。
