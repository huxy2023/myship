# MyShip 品牌素材

当前采用 B 方向的小海豹 Skipper：奶油色身体、浅青色鳍肢、小号珊瑚橘纸船帽，搭配深墨蓝背景。新版回到生成图的柔和质感，避免把主形象几何化。

## 按用途选择格式

| 文件（`apps/site/public/`） | 用途 |
| --- | --- |
| `mascot-skipper.png` | 1254 × 1254 的主形象，官网角色卡片、README 和介绍材料使用 |
| `logo.png` | 同一主形象，用于项目头像与应用入口 |
| `logo.svg` | 简化矢量图标，网站导航栏和离线控制台使用 |
| `favicon.svg` | 头像进一步简化，适配 16–32 px 浏览器标签页 |
| `apple-touch-icon.png` | 180 × 180，添加到手机主屏幕时使用 |
| `og-banner.png` | 1200 × 630，README 首屏与 Open Graph / Twitter 分享图 |
| `og-banner.svg` | 分享图的排版导出源，嵌入主形象 PNG；角色本身不是矢量重绘 |

`mascot-skipper.svg` 保留为矢量备用稿，官网主形象不使用它。图片格式由用途决定，不要求全部转换为 SVG。

## 维护方式

- 主形象由内置 image_gen 基于用户选定的 B 方向生成。调整要求：纸船帽缩小；帽子改珊瑚橘、鳍肢改浅青色、背景改深墨蓝；保留原有身体、表情和柔和质感。更新时同步 `mascot-skipper.png` 与 `logo.png`。
- 小图标的矢量源位于 [`packages/cli/brand.mjs`](../packages/cli/brand.mjs)。控制台直接内联，无需向官网请求图片。
- `pnpm build:site` 导出小图标和分享图排版源，并复制素材到站点产物。分享图排版位于 [`apps/site/build-site.mjs`](../apps/site/build-site.mjs) 的 `renderBrandBanner()`。
- 更新主形象或排版后，同步导出 1200 × 630 的 `og-banner.png`；更新 favicon 后，同步导出 180 × 180 的手机图标。构建不会自动重绘 PNG。
- 主形象保留留白，不拉伸比例。官网卡片以圆角展示原图；小于 32 px 时优先使用简化图标。

## 配色方向

| 部位 | 色值参考 |
| --- | --- |
| 背景 | `#203A50` 深墨蓝 |
| 身体 | `#FFF3E3` 奶油白 |
| 纸船帽 | `#F39A78` 珊瑚橘 / `#FFD0B5` 浅桃色 |
| 鳍肢 | `#9CD7D6` 浅青色 |
| 脸颊 | `#FFB18D` 杏桃色 |
| 五官 | `#303537` 炭灰色 |

标语仍为「自有云海，一令启航。」 / “Your Cloud. Your Fleet. One Command to Ship.”。
