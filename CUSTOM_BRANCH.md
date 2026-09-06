# my_custom 分支维护说明

本文件记录 `my_custom` 分支(基于上游 Readest 的私有定制)的基线、自定义提交与
后续合并上游新 tag 的操作约定。**合并上游前请先读本文件。**

## 当前基线

| 项 | 值 |
| --- | --- |
| 分支 | `my_custom`(由本地 `main` 创建) |
| 上游 tag | `v0.12.6`(上游 commit `f6146c217`) |
| 分支起点(origin/main) | `cef42c907`(v0.12.6 之后的 2 个上游提交:42dcf2f70 #6057、cef42c907 #6058) |
| 远程 | `origin` = git@github.com:fsca8/readest.git(自维护 fork) |

## 本分支的自定义提交(cherry-pick 用,按序)

```
d461a43eb  feat(sync): 第三方自带存储后端(WebDAV/GDrive/S3/OneDrive/iCloud)
           移出 Premium,Readest Cloud 保持付费
c97e82ad1  fix(sync): WebDAV 传输防卡死加固 — plugin-http abort 无效改用硬截止
           竞速;流式传输停滞看门狗;Rust 侧 connect/总超时与多段下载完整性校验
```

> 后续如有新的定制提交,请继续以小而独立的 commit 追加,并同步更新本清单 —
> 保持每个定制提交可独立 cherry-pick,是整套维护流程的前提。

## 合并上游新 tag 的流程(推荐:cherry-pick 重放)

自定义改动很少且集中,不建议把上游整树 merge 进定制分支后手工解冲突
(冲突会逐次累积、无法追溯)。推荐每次升级都在新基线重放定制提交:

```bash
# 1. 取上游最新 tag(首次需添加 upstream 远程;若 fork 镜像了上游 tag,
#    直接 fetch origin 的 tag 亦可)
git remote add upstream <上游仓库地址>   # 仅首次
git fetch upstream --tags

# 2. 以新 tag 为基线重建定制分支(假设最新 tag 为 vX.Y.Z)
git checkout -b my_custom_v2 upstream/vX.Y.Z   # 或 vX.Y.Z

# 3. 按序 cherry-pick 本分支的全部定制提交
git cherry-pick d461a43eb c97e82ad1

# 4. 解决冲突(如遇),重点检查下方"定制改动集中区";然后
# 5. 跑测试与构建验证:pnpm lint / 相关 vitest / tauri build(见下)
# 6. 确认后:更新本文件的基线表格,再推送/替换 my_custom
```

## 就地合并(备选,仅在不想重建分支时)

```bash
git fetch upstream --tags
git merge upstream/vX.Y.Z        # 在 my_custom 上
# 解决冲突后同样需要完整验证
```

## 定制改动集中区(冲突高发文件)

升级时上游若动过这些文件,冲突几乎必然发生:

- `apps/readest-app/src/utils/access.ts`(付费墙总开关 `CLOUD_SYNC_REQUIRES_PREMIUM`)
- `apps/readest-app/src/components/settings/IntegrationsPanel.tsx`(Premium 徽标/路由)
- `apps/readest-app/src/components/settings/integrations/cloudSyncStatus.ts`
- `apps/readest-app/src/services/sync/providers/webdav/client.ts` / `WebDAVProvider.ts`
- `apps/readest-app/src-tauri/src/transfer_file.rs`

## 合并后验证

- `pnpm lint`(tsc + biome)
- 单测:`pnpm exec dotenv -e .env -e .env.test.local -- vitest run \
  src/__tests__/services/sync/providers/webdavClientTimeout.test.ts \
  src/__tests__/services/sync/providers/webdavProviderStream.test.ts` 等
- 桌面构建须经 tauri CLI(裸 cargo build 缺 custom-protocol feature):
  `pnpm exec dotenv -e .env -e .env.tauri -- next build && \
   pnpm exec dotenv -e .env -e .env.tauri -- tauri build --no-bundle`

## 版本准确性约定

二进制内嵌的版本/commit 信息取自构建时的 git HEAD —— **先提交全部改动、
再构建**;本地有未提交改动时构建会带 `-dirty`,不利于追溯。
