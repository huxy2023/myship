# MyShip 品牌素材

当前采用 B 方向的小海豹 **Skipper**：纯净暖奶油色身体与同色系软萌小前鳍、小号珊瑚橘折纸船帽、蜜桃粉腮红，搭配透明背景、两笔清透海蓝水波纹与轻柔的呼吸浮动微动效。

## 按用途选择格式

| 文件（`apps/site/public/`） | 用途 |
| --- | --- |
| `mascot-skipper.svg` | 透明底带轻柔呼吸浮动动效的主形象矢量图，官网角色卡片与 README 使用（自适应深浅色模式） |
| `logo.svg` | 静谧海蓝底衬的矢量图标，网站导航栏与离线控制台使用 |
| `favicon.svg` | 头像简化版矢量图标，适配 16–32 px 浏览器标签页 |
| `apple-touch-icon.png` | 180 × 180，添加到手机主屏幕时使用 |
| `og-banner.svg` | 1200 × 630 分享图矢量排版源 |
| `og-banner.png` | 1200 × 630，README 首屏与 Open Graph / Twitter 社交卡片分享图 |

## 维护方式

- 统一矢量源位于 [`packages/cli/brand.mjs`](../packages/cli/brand.mjs)，离线控制台直接内联，无需向官网请求外部图片。
- `pnpm build:site` 自动从 `packages/cli/brand.mjs` 导出 `mascot-skipper.svg`、`logo.svg`、`favicon.svg` 与 `og-banner.svg`（位于 [`apps/site/build-site.mjs`](../apps/site/build-site.mjs) 的 `renderBrandBanner()`），并同步复制到站点产物目录。
- 更新矢量源或分享图排版后，同步导出对应的光栅图（`og-banner.png` 与 `apple-touch-icon.png`）。

## 配色规范

| 部位 | 色值参考 | 说明 |
| --- | --- | --- |
| 身体 | `#FFF9EE` → `#FCECD5`（描边 `#F2DCC0`） | 暖奶油白柔和渐变，避免灰暗阴影 |
| 小前鳍（小手） | `#FAE3C6`（底影 `#EBCAA5`） | 与身体同色系的暖杏奶白，拒绝突兀异色块或脏卡其色 |
| 折纸船帽 | `#F38D68` 珊瑚橘 / `#FFD2B8` 浅桃 / `#FFF6EC` 暖白 | 全身唯一点睛主色，折面严密无空隙 |
| 腮红 | `#FFAE90` 蜜桃粉 | 与珊瑚橘纸船帽温暖呼应 |
| 五官 | `#2C3135` 深暖炭灰 | 保持呆萌简洁的椭圆比例 |
| 海浪波纹 | `#78BEE0` / `#A2D6EE` 清透海蓝 | 两笔轻盈弧线托底，表现海上启航 |
| 图标底色 | `#5693BE` → `#3B729C` 静谧海蓝 | 用于 `logo.svg` 与 `favicon.svg`，确保小尺寸下高对比度清晰可辨 |

品牌标语为 **「自有云海，一令启航。」** / **“Your Cloud. Your Fleet. One Command to Ship.”**。
