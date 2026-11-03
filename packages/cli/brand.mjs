/**
 * packages/cli/brand.mjs — MyShip 统一品牌视觉与吉祥物 Skipper 矢量源
 *
 * 设计规范（B 方向 · 纸船帽小海豹 Skipper）：
 * - 身体与小前鳍同属纯净暖奶油色系（身体 #FFF9EE → #FCECD5，前鳍 #FAE3C6），无生硬线框、异色块或灰暗阴影
 * - 头顶佩戴小号珊瑚橘折纸船帽（#F38D68 / #FFD2B8 / #FFF6EC），与蜜桃粉腮红（#FFAE90）温暖呼应
 * - 主形象采用透明底 + 清透海蓝水波纹（#78BEE0 / #A2D6EE）+ 轻柔呼吸浮动动效，自适应深浅双主题
 * - 导航栏 Logo 与 Favicon 采用静谧海蓝底衬（#5693BE → #3B729C），确保 16–32px 下高对比度清晰可辨
 */

const SKIPPER_DEFS = `
  <defs>
    <linearGradient id="skipper-body-grad" x1="0.2" y1="0.08" x2="0.82" y2="0.96">
      <stop offset="0%" stop-color="#FFF9EE"/>
      <stop offset="100%" stop-color="#FCECD5"/>
    </linearGradient>
    <linearGradient id="skipper-icon-bg" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="#5693BE"/>
      <stop offset="100%" stop-color="#3B729C"/>
    </linearGradient>
  </defs>`;

const SKIPPER_CHARACTER = `
    <!-- 圆润暖奶油身体（带极柔和暖色细边，在纯白与深色背景上均清晰干净） -->
    <path fill="url(#skipper-body-grad)" stroke="#F2DCC0" stroke-width="2.5" stroke-linejoin="round" d="M80 358C66 302 110 217 169 165C202 136 236 128 267 138C343 149 397 240 410 333C436 315 461 332 451 360C431 410 363 448 261 452C158 456 95 428 81 391C78 381 78 369 80 358Z"/>
    <!-- 肚皮底部柔和暖光过渡 -->
    <path fill="#F5DCB8" opacity="0.38" d="M98 408C136 436 196 446 266 444C344 441 404 414 434 376C416 419 354 449 261 452C168 455 108 432 86 398C90 402 94 405 98 408Z"/>

    <!-- 小号珊瑚橘折纸船帽（严密折面无空隙） -->
    <g class="skipper-hat">
      <g transform="translate(292 146) scale(0.62) translate(-292 -146)">
        <path fill="#FFF6EC" d="M242 122L316 52L364 148Z"/>
        <path fill="#FFD2B8" d="M316 52L364 148L294 128Z"/>
        <path fill="#F38D68" d="M222 80Q219 78 220 84L231 146Q231 150 235 152L337 190Q341 192 344 188L391 139Q395 135 389 134L291 120Z"/>
      </g>
    </g>

    <!-- 随身体微倾的五官与蜜桃粉腮红 -->
    <g class="skipper-eyes" fill="#2C3135">
      <ellipse cx="183" cy="230" rx="13" ry="19" transform="rotate(19 183 230)"/>
      <ellipse cx="286" cy="258" rx="13" ry="19" transform="rotate(19 286 258)"/>
    </g>
    <ellipse cx="239" cy="250" rx="12" ry="9" transform="rotate(12 239 250)" fill="#2C3135"/>
    <path d="M219 263Q232 283 254 274" fill="none" stroke="#2C3135" stroke-width="7" stroke-linecap="round"/>

    <g fill="#FFAE90">
      <ellipse cx="151" cy="271" rx="20" ry="16.5" transform="rotate(12 151 271)"/>
      <ellipse cx="316" cy="301" rx="20" ry="16.5" transform="rotate(12 316 301)"/>
    </g>

    <!-- 与身体同色系的暖杏奶白小前鳍（无异色突兀感、无脏灰阴影） -->
    <g class="skipper-flippers">
      <ellipse cx="114" cy="383" rx="26" ry="47" transform="rotate(34 114 383)" fill="#EBCAA5" opacity="0.4"/>
      <ellipse cx="112" cy="380" rx="26" ry="47" transform="rotate(34 112 380)" fill="#FAE3C6"/>
      <ellipse cx="268" cy="407" rx="29" ry="48" transform="rotate(34 268 407)" fill="#EBCAA5" opacity="0.4"/>
      <ellipse cx="266" cy="404" rx="29" ry="48" transform="rotate(34 266 404)" fill="#FAE3C6"/>
    </g>`;

const SKIPPER_WAVES = `
  <!-- 清透海蓝水波纹（仅用两笔轻盈弧线表现海上启航） -->
  <g fill="none" stroke-linecap="round">
    <path class="skipper-wave-1" stroke="#78BEE0" stroke-width="5" stroke-opacity="0.72" d="M118 474Q166 458 214 472T310 472T384 468"/>
    <path class="skipper-wave-2" stroke="#A2D6EE" stroke-width="4" stroke-opacity="0.55" d="M190 493Q234 481 278 492T364 490"/>
  </g>`;

export const MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="seal-title">
  <title id="seal-title">MyShip · Skipper，戴纸船帽的小海豹</title>
  <style>
    .skipper-float {
      transform-origin: 256px 320px;
      animation: skipper-bob 4.2s ease-in-out infinite;
    }
    .skipper-hat {
      transform-origin: 295px 145px;
      animation: skipper-hat-tilt 4.2s ease-in-out infinite;
    }
    .skipper-eyes {
      transform-origin: 235px 244px;
      animation: skipper-blink 5.6s ease-in-out infinite;
    }
    .skipper-wave-1 {
      animation: skipper-wave-a 4.2s ease-in-out infinite;
    }
    .skipper-wave-2 {
      animation: skipper-wave-b 4.2s ease-in-out infinite;
    }
    @keyframes skipper-bob {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-8px) rotate(-1.2deg); }
    }
    @keyframes skipper-hat-tilt {
      0%, 100% { transform: rotate(0deg) translateY(0px); }
      50% { transform: rotate(2.4deg) translateY(-2px); }
    }
    @keyframes skipper-blink {
      0%, 44%, 48%, 100% { transform: scaleY(1); }
      46% { transform: scaleY(0.12); }
    }
    @keyframes skipper-wave-a {
      0%, 100% { transform: translateX(0px); opacity: 0.72; }
      50% { transform: translateX(-6px); opacity: 0.95; }
    }
    @keyframes skipper-wave-b {
      0%, 100% { transform: translateX(0px); opacity: 0.52; }
      50% { transform: translateX(6px); opacity: 0.78; }
    }
    @media (prefers-reduced-motion: reduce) {
      .skipper-float, .skipper-hat, .skipper-eyes, .skipper-wave-1, .skipper-wave-2 {
        animation: none !important;
      }
    }
  </style>${SKIPPER_DEFS}
  <g class="skipper-float">${SKIPPER_CHARACTER}
  </g>${SKIPPER_WAVES}
</svg>`;

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="logo-title">
  <title id="logo-title">MyShip</title>${SKIPPER_DEFS}
  <rect width="512" height="512" rx="116" fill="url(#skipper-icon-bg)"/>
  <g transform="translate(8 10)">${SKIPPER_CHARACTER}
  </g>
  <path fill="none" stroke="#A2D6EE" stroke-width="6" stroke-linecap="round" stroke-opacity="0.58" d="M136 474Q192 460 248 473T360 471"/>
</svg>`;

// A head-only reduction on a serene ocean-blue tile keeps the cream seal and coral paper boat crisp at 16–32 px.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>MyShip</title>
  <defs>
    <linearGradient id="fav-bg" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="#5693BE"/>
      <stop offset="100%" stop-color="#3B729C"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#fav-bg)"/>
  <path fill="#FFF9F0" d="M9 46C9 30 20 20 32 21C45 21 55 34 55 47C55 56 45 59 32 59C19 59 9 55 9 46Z"/>
  <g transform="translate(40 23) scale(.72) translate(-40 -23)">
    <path fill="#FFF6EC" d="M29 15L42 5L49 21Z"/>
    <path fill="#FFD2B8" d="M42 5L49 21L39 17Z"/>
    <path fill="#F38D68" d="M26 10L39 17L55 20L46 29L28 23Z"/>
  </g>
  <g fill="#2C3135">
    <ellipse cx="23.5" cy="39" rx="2.8" ry="3.9" transform="rotate(12 23.5 39)"/>
    <ellipse cx="41.5" cy="42" rx="2.8" ry="3.9" transform="rotate(12 41.5 42)"/>
    <ellipse cx="32.5" cy="41.5" rx="2.2" ry="1.6" transform="rotate(10 32.5 41.5)"/>
  </g>
  <path d="M28.5 46.5Q32.5 50.5 36.8 47.5" fill="none" stroke="#2C3135" stroke-width="2.5" stroke-linecap="round"/>
  <g fill="#FFAE90">
    <ellipse cx="17.5" cy="44" rx="3.6" ry="2.6" transform="rotate(10 17.5 44)"/>
    <ellipse cx="46.5" cy="48" rx="3.6" ry="2.6" transform="rotate(10 46.5 48)"/>
  </g>
</svg>`;
