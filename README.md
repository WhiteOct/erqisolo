# 二气传说（网页版）

纯前端单页游戏，资源外置为相对路径，适合 GitHub Pages 托管。

## 目录结构
- index.html            游戏本体（无内嵌大资源）
- assets/img/           立绘：enemy1 / enemycp / enemybj / enemyld
- assets/music/         背景音乐：bgm-default / bgm-boss / bgm-steam（AAC / MP4 容器）
- .nojekyll             让 GitHub Pages 原样发布（不做 Jekyll 处理）

## 上传到 GitHub Pages
1. 新建仓库（Public），把本文件夹里的**全部内容**（含 assets 目录）传到仓库根目录。
2. 仓库 Settings → Pages → Build and deployment：Source 选 “Deploy from a branch”，
   Branch 选 main，Folder 选 /(root)，保存。
3. 等 1~2 分钟，访问 https://<用户名>.github.io/<仓库名>/ 即可。
4. 想放子目录（如 /docs）就把这些文件放进仓库 docs/，Pages 里选 /docs。

## 本地运行
直接双击 index.html 也能玩（相对路径在 file:// 下同样有效）。

## 注意
- 请勿把桌面上的源图/源音频（enemy*.jpg、*.aac、*_clean.png、build_site.ps1 等）一起上传。
- 手机端首次点“开始游戏”才加载对应 BGM（已设 preload=none，省流量）。