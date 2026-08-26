# NapCat `sendMsg/onMsgInfoListUpdate` 超时研究（2026-08-26）

## 结论

本次超时的直接原因不是正文长度、Markdown、URL，也不是本机 QQ.app。实际链路是：

```text
qq-bot-v2 Agent Core
  -> QQ Gateway（本机）
  -> node-napcat-ts / OneBot WebSocket（[::1]:3001）
  -> OrbStack 容器 napcat
  -> 容器内 Linux QQNT 内核
```

容器日志已经在 **2026-08-24 13:27:00** 明确记录：

```text
[KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。
账号状态变更为离线
```

此后直到 8 月 26 日发送故障发生前，没有新的入站消息或重新登录成功记录。8 月 26 日的长文、缩短版和纯文本 `hi` 都走到同一结果：NapCat 调用 QQNT 的 `NodeIKernelMsgService/sendMsg` 后，在 10 秒内既未拿到可记录的 service result，也未收到与本次消息匹配且状态为 `KSEND_STATUS_SUCCESS` 的 `NodeIKernelMsgListener/onMsgInfoListUpdate`，于是由 **NapCat 自己**构造并返回超时错误。

因此，针对本次实例，证据最强的解释是：**容器内 QQ 会话已被 QQNT 判定失效，而 NapCat/OneBot WebSocket 和 qq-bot-v2 的 Gateway 进程仍然存活，造成“传输连接健康、QQ 账号实际上离线”的假健康状态；发送请求进入离线 QQNT 内核后得不到发送完成回调。**

更上游的“QQ 为什么踢下线”无法从现有日志确定。NapCat 的 `KickedOffLineInfo` 类型其实还有 `sameDevice`、`kickedType`、`securityKickedType` 等字段，但 v4.17.52 的日志只输出 `tipsTitle` 和 `tipsDesc`，本次没有保存那些分类字段；因此不能实事求是地归因为挤号、风控、token 过期或某个确定的 QQNT bug。[NapCat v4.17.52 `KickedOffLineInfo`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/types/msg.ts#L15-L23)；[下线处理仅记录标题和描述](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/index.ts#L233-L239)

## 本机证据

### 实际运行版本

只读检查得到：

- 容器：`napcat`，镜像标签 `mlikiowa/napcat-docker:latest`；运行中的镜像实际创建于 2026-03-14，并不是 2026-08-26 时的最新构建。
- 容器内 NapCat：`4.17.52`。
- 容器内 QQNT：Linux `3.2.25-45758`。
- 仓库内 `node-napcat-ts`：`0.4.21`，锁文件也固定解析到这一版本。
- 对运行中 OneBot WebSocket 做只读 `get_status` 得到 `{ online: false, good: true }`；`get_version_info` 同时返回 `4.17.52`。这直接确认了“adapter 仍可响应，但 QQ 账号离线”。NapCat v4.17.52 的 `get_status` 源码也表明 `online` 来自 `core.selfInfo.online`，而 `good` 被固定写成 `true`，所以 `good: true` 不能解释为 QQ 在线。[v4.17.52 `GetStatus`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-onebot/action/system/GetStatus.ts#L5-L32)
- NapCat 上游截至 2026-08-26 的最新 release 是 `4.18.19`（2026-08-14 发布）；所以 Docker 的 `latest` 标签并不表示已运行的旧容器会自动拉取新镜像。[NapCat v4.17.52 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.17.52)；[NapCat v4.18.19 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.19)

本地 Docker image digest 与 registry 当前 `latest` digest 也不同，进一步确认“本机标签叫 latest，但实际运行的是 3 月镜像”。v4.17.52 的发布说明要求 QQ 版本至少为 40768，当前容器的 45758 高于该最低值，因此没有证据支持“QQ 版本低于 NapCat 明示最低版本”这一解释。不过 NapCat 和 QQNT 都明显落后于当前 release，升级仍有已知收益，见下文。

### 时间线

容器日志的关键序列是：

| 时间（本机日志） | 证据 |
| --- | --- |
| 2026-08-24 13:26:50 | 最后一条正常收到的群消息 |
| 2026-08-24 13:27:00 | `[KickedOffLine] ... 登录已失效，请重新登录` |
| 2026-08-24 13:27:01 | `账号状态变更为离线` |
| 2026-08-26 13:47:52 起 | 多轮私聊发送，每轮约 10 秒后 `sendMsg/onMsgInfoListUpdate` timeout |
| 2026-08-26 13:54:14、13:54:25 | 纯文本 `hi` 两次也超时 |

“长消息失败”和“`hi` 也完全相同地失败”排除了正文长度、链接语法和 Markdown 渲染作为本次主因。日志中的每次超时都显示 `EventRet: {}`，而不是 `{ result: 0, errMsg: "" }` 或显式的媒体传输错误；这说明该次等待期内 NapCat 连 QQNT `sendMsg` 的可记录返回都没有拿到，而不仅仅是成功消息更新没有被 checker 匹配。

可复核的只读命令：

```bash
docker inspect napcat
docker image inspect mlikiowa/napcat-docker:latest
docker exec napcat sh -lc 'grep -E "\"(version|buildVersion|name)\"" /opt/QQ/resources/app/package.json'
docker logs --since '2026-08-24T13:20:00+08:00' napcat
```

## 这个错误究竟由哪一层发出

### 1. `node-napcat-ts` 只是 OneBot 请求/响应相关器

`node-napcat-ts@0.4.21` 的 `send_private_msg()` 只是调用通用 `send('send_private_msg', params)`；通用 `send()` 生成 `echo`，写入 WebSocket，并等待相同 `echo` 的 OneBot response。该版本没有 per-request timeout；收到 `retcode !== 0` 时，它把 NapCat 的 response 原样 reject 给调用方。[`send_private_msg()` 源码](https://github.com/HkTeamX/node-napcat-ts/blob/f5136fabaf289eda7a0f7b70ca141e0a316148f3/src/NCWebsocketApi.ts#L4-L11)；[`send()` 和 echo map](https://github.com/HkTeamX/node-napcat-ts/blob/f5136fabaf289eda7a0f7b70ca141e0a316148f3/src/NCWebsocketBase.ts#L214-L266)；[response 分派](https://github.com/HkTeamX/node-napcat-ts/blob/f5136fabaf289eda7a0f7b70ca141e0a316148f3/src/NCWebsocketBase.ts#L165-L175)

所以日志里的精确字符串：

```text
Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg
ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet: {}
```

不是 `node-napcat-ts` 生成的，也不是 QQ Gateway 的 30 秒 HTTP timeout。

### 2. 10 秒 timeout 是 NapCat v4.17.52 生成的

NapCat 的 `NTQQMsgApi.sendMsg()` 默认 timeout 为 10,000 ms。它先生成一个临时 `msgId`，把它塞进 `peer.guildId` 作为本次发送的相关键，然后同时：

1. 调 QQNT `NodeIKernelMsgService/sendMsg`；
2. 监听 `NodeIKernelMsgListener/onMsgInfoListUpdate`；
3. 只接受列表里 `guildId === msgId` 且 `sendStatus === KSEND_STATUS_SUCCESS (2)` 的记录。

源码证据：[NapCat v4.17.52 `NTQQMsgApi.sendMsg`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/apis/msg.ts#L232-L264)；[`SendStatusType`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/types/msg.ts#L494-L502)

底层 `callNormalEventV2()` 在 timeout 到期时，如果合格 listener callback 一次都没有到达（`complete === 0`），就拼出当前看到的 `Timeout: NTEvent ... EventRet: ...` 错误。[NapCat v4.17.52 `callNormalEventV2`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/helper/event.ts#L173-L218)；[listener checker 分派](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/helper/event.ts#L96-L108)

OneBot WebSocket action 捕获这个异常后，把它变成 `status: failed, retcode: 1200` 的 response；`node-napcat-ts` 因 `retcode !== 0` reject promise。[NapCat v4.17.52 WebSocket action error mapping](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-onebot/action/OneBotAction.ts#L104-L115)

### 3. qq-bot-v2 又把 NapCat 的一次失败重试为两次

仓库的私聊发送叶节点对任何异常都做两次尝试、间隔 1 秒：[`src/messaging/napcat-sender.ts`](../../src/messaging/napcat-sender.ts)。因此一次 `send_message` 工具调用通常会形成两次约 10 秒的 NapCat 内核等待。QQ Gateway client 的 30 秒 HTTP 上限只是外层边界：[`src/services/qq-gateway-client.ts`](../../src/services/qq-gateway-client.ts)。

## 为什么 Gateway 还显示 `connected: true`

当前 QQ Gateway 在 `connectNapcat()`（即 OneBot WebSocket 建连）成功后把模块级 `connected` 设为 `true`，之后只在 Gateway shutdown 时设回 `false`；它没有订阅或传播 QQNT 的 `KickedOffLine` / `selfInfo.online`。`/health` 直接使用这个 transport-level 布尔值：[`src/services/qq-gateway.ts`](../../src/services/qq-gateway.ts)。

因此当前 `connected: true` 的准确含义只是“QQ Gateway 到 NapCat OneBot WebSocket 仍连着”，不是“容器内 QQ 账号在线且可发消息”。直接 `get_status` 已给出 `online: false`。NapCat v4.17.52 自己确实会在 `onKickedOffLine` 和 self status 20 时设置 `selfInfo.online = false`，并能发出 OneBot `bot_offline` notice；`node-napcat-ts@0.4.21` 也会把它解析为 `notice.bot_offline`。但 qq-bot-v2 当前既没有在 health 时调用 `get_status`，也没有订阅这个 notice。[NapCat v4.17.52 下线状态更新](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-core/index.ts#L233-L262)；[NapCat `BotOfflineEvent`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-onebot/event/notice/BotOfflineEvent.ts#L1-L15)；[`node-napcat-ts` offline notice 分派](https://github.com/HkTeamX/node-napcat-ts/blob/f5136fabaf289eda7a0f7b70ca141e0a316148f3/src/NCEventBus.ts#L242-L247)

群列表仍能读取也不反证 QQ 在线：这类列表可能来自 QQNT 的本地缓存；而需要在线内核完成的发送和好友查询可以同时卡住。

## 这个错误签名是否唯一指向“离线”

不是。该签名准确表达的是“NapCat 没等到满足 checker 的 QQNT 消息更新”，不是一个独有根因码。上游一手 issue 还记录过：

- QQ/NapCat 长时间运行后内核不再收发，但进程/WebUI 仍在；旧问题最终建议升级到 NapCat 4.7.8 + QQ 33139。[NapCatQQ #869](https://github.com/NapNeko/NapCatQQ/issues/869#issuecomment-2745140942)
- 单向好友私聊在旧版本中也会发送超时。[NapCatQQ #72](https://github.com/NapNeko/NapCatQQ/issues/72)
- 图片、JSON 卡片或媒体传输故障也可表现为同一 listener timeout；有时 `EventRet` 会是 `{ result: 0 }`，有时新版本直接给 `EventChecker Failed` 和 `rich media transfer failed`。[NapCatQQ #1700](https://github.com/NapNeko/NapCatQQ/issues/1700)；[NapCatQQ #2002](https://github.com/NapNeko/NapCatQQ/issues/2002)

但这些只是说明错误字符串不具唯一性，不能覆盖本机更直接的证据。本机先出现明确 `KickedOffLine`，两天内无入站或重登录记录，随后连 `hi` 都失败，因此“账号会话已失效”明显强于消息内容、媒体、目标类型或偶发单次回调丢失。

### 与本机 QQNT 45758 高度相似的上游报告

NapCatQQ 的正式 issue 中，至少有三份 2026 年报告使用了与本机相同的 Linux QQNT `3.2.25-45758`：

- NapCat 4.17.53：运行数小时后频繁 `KickedOffLine`；报告者把它描述为风控，并以降级 NapCat/QQ 为临时绕过。[NapCatQQ #1728](https://github.com/NapNeko/NapCatQQ/issues/1728)
- NapCat 4.18.0：频繁或静默下线，日志同样是“帐号当前登录已失效，请重新登录”。[NapCatQQ #1796](https://github.com/NapNeko/NapCatQQ/issues/1796)
- NapCat 4.18.1：同一账号在 Docker 和 Shell 部署中都会发生 `KickedOffLine`，报告者据此认为不只由 Docker 环境触发。[NapCatQQ #1817](https://github.com/NapNeko/NapCatQQ/issues/1817)

这些报告与本机的版本和症状高度相似，说明“45758 + 当时一批 NapCat 版本的长期登录稳定性”有真实先例；但三个 issue 都没有关联已合并修复，其中两个是 `closed as not planned`，不能把报告者的“风控”判断升级为腾讯或 NapCat 维护者确认的 root cause。它们把“版本组合/登录实现可能相关”的证据从猜测提高到中等，仍不足以回答本次 `kickedType/securityKickedType` 究竟是什么。

## 已知版本问题与修复状态

### v4.17.52 的明确缺陷：被踢后 WebUI 登录状态不复位

当前容器的 v4.17.52 收到 `KickedOffLine` 时只设置 WebUI error，没有把 `QQLoginStatus` 设回 false。[v4.17.52 `base.ts`](https://github.com/NapNeko/NapCatQQ/blob/c7109e20ad1e26654765d92d71b0e89ad6a6c17e/packages/napcat-shell/base.ts#L785-L788)

上游 PR #1896 把这件事确认为 root cause：被 QQ 踢下线后，WebUI 仍认为已登录，会阻止二维码、快速登录或密码登录，直到 NapCat 重启。修复是在 `KickedOffLine` handler 里调用 `setQQLoginStatus(false)`；该修复进入了 v4.18.7，release note 写的是“登录状态重置”。[修复 commit `fbd70bbb`](https://github.com/NapNeko/NapCatQQ/commit/fbd70bbb0443456fff22602187e670549c3c126d)；[PR #1896](https://github.com/NapNeko/NapCatQQ/pull/1896)；[v4.18.7 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.7)

这能解释为什么当前旧容器在被踢后不会自动恢复、WebUI 可能仍显得部分正常。它修复的是**重新登录入口的状态同步**，不是证明会消除 QQ 侧踢下线。

### 截至 2026-08-26 仍没有“自动恢复被踢会话”的已确认修复

上游 #1962 描述了 Docker 部署被踢后静默空转、二维码刷新无效的剩余问题；截至 2026-08-26 仍为 open。即便升级到最新 v4.18.19，也没有一手证据表明 NapCat 会在这类 `KickedOffLine` 后自动恢复会话。[NapCatQQ #1962](https://github.com/NapNeko/NapCatQQ/issues/1962)

因此最稳妥的区分是：

- **已确认修复**：v4.18.7+ 会在 `KickedOffLine` 时复位 WebUI 的 login-status，使重新登录不再被旧状态直接挡住。
- **未确认修复**：自动重新登录、自动生成新二维码、阻止以后再次被 QQ 踢下线。
- **本次即时恢复所需**：让容器内 QQNT 获得新的有效登录会话；对当前 v4.17.52，重启 NapCat/QQNT 后重新登录是上游已知的实际绕过路径。是否升级镜像、何时重启属于有副作用操作，本研究没有执行。

## 对 qq-bot-v2 的含义

后续若要改代码，建议按优先级拆成三个窄改动（本文件只研究，不实施）：

1. **健康语义**：QQ Gateway 应区分 `transportConnected` 与 `qqOnline`，收到下线事件后 readiness 立即失败；否则 Agent 会在确定离线时继续调用发送。
2. **重试策略**：对已知 `KickedOffLine` 状态不做发送重试；当前两次底层重试只会把单次失败拉长约 21 秒，并增加重复风险。
3. **结果分类**：不能仅凭所有 `sendMsg/onMsgInfoListUpdate` timeout 就统一断言“未发送”。`EventRet: {}`、`EventRet: {result: 0}`、显式 `EventChecker Failed` 应分开记录；若 QQ 在线状态已明确为 false，则可以把本次归为 provider unavailable，而不是普通内容失败。

## 证据强弱

| 结论 | 强度 | 依据 |
| --- | --- | --- |
| 本次不是本机 QQ.app | 高 | 网络/进程链直接指向 OrbStack 容器 `[::1]:3001` |
| 超时字符串由 NapCat 生成 | 高 | v4.17.52 源码与容器堆栈完全对应 |
| NapCat 等待的是同一临时 msgId 且 `sendStatus=2` 的 `onMsgInfoListUpdate` | 高 | v4.17.52 发送源码 |
| 本次发送时容器内 QQ 会话已失效 | 高 | 提前两天的明确 `KickedOffLine` + offline 日志；其后无入站/重登录；纯文本也失败 |
| 为什么 `/health` 仍 connected | 高 | qq-bot-v2 当前源码只跟踪 OneBot WebSocket 建连；直接 OneBot `get_status` 同时返回 `online:false, good:true` |
| QQ 为什么踢下线 | 不足 | 原始分类字段未落日志；只能确认“登录已失效”，不能确认挤号/风控/token/QQNT 缺陷中的哪一种 |
| QQNT 45758 / 当时 NapCat 版本可能更容易掉线 | 中 | #1728、#1796、#1817 的同版本正式报告，但无维护者确认的单一根因或合并修复 |
| 升级后绝不会再发生 | 不足 | 上游仍有 open issue；v4.18.7 修的是重新登录状态同步，不是踢线根因 |
