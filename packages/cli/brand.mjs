/** Small vector marks for navigation and the offline console. The main mascot uses PNG. */
const seal = `
  <!-- Cream body and small tail; the silhouette stays continuous at every size. -->
  <path fill="#FFF3E3" d="M80 358C66 302 110 217 169 165C202 136 236 128 267 138C343 149 397 240 410 333C436 315 461 332 451 360C431 410 363 448 261 452C158 456 95 428 81 391C78 381 78 369 80 358Z"/>
  <!-- Paper boat: three broad folds, no rigging or extra decorations. -->
  <g transform="translate(290 145) scale(.6) translate(-290 -145)">
  <path fill="#FFF8ED" d="M237 111L315 55L359 145Z"/>
  <path fill="#FFD0B5" d="M315 55L359 145L294 124Z"/>
  <path fill="#F39A78" d="M222 80Q219 78 220 84L231 146Q231 150 235 152L337 190Q341 192 344 188L391 139Q395 135 389 134L291 120Z"/>
  </g>
  <!-- Face tilted with the body. -->
  <g fill="#303537">
    <ellipse cx="183" cy="230" rx="13" ry="19" transform="rotate(19 183 230)"/>
    <ellipse cx="286" cy="258" rx="13" ry="19" transform="rotate(19 286 258)"/>
    <ellipse cx="239" cy="250" rx="12" ry="9" transform="rotate(12 239 250)"/>
  </g>
  <path d="M219 263Q232 283 254 274" fill="none" stroke="#303537" stroke-width="7" stroke-linecap="round"/>
  <g fill="#FFB18D">
    <ellipse cx="151" cy="271" rx="20" ry="17" transform="rotate(12 151 271)"/>
    <ellipse cx="316" cy="301" rx="20" ry="17" transform="rotate(12 316 301)"/>
  </g>
  <g fill="#9CD7D6">
    <ellipse cx="111" cy="383" rx="27" ry="49" transform="rotate(36 111 383)"/>
    <ellipse cx="268" cy="407" rx="31" ry="51" transform="rotate(36 268 407)"/>
  </g>`;

export const MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="seal-title">
  <title id="seal-title">MyShip · Skipper，戴纸船帽的小海豹</title>${seal}
</svg>`;

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="logo-title">
  <title id="logo-title">MyShip</title>
  <rect width="512" height="512" rx="112" fill="#203A50"/>${seal}
</svg>`;

// A head-only reduction keeps the eyes and paper boat legible at 16–32 px.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>MyShip</title>
  <rect width="64" height="64" rx="15" fill="#203A50"/>
  <path fill="#FFF3E3" d="M9 45C9 30 20 20 32 21C45 21 55 34 55 47C55 56 45 59 32 59C19 59 9 55 9 45Z"/>
  <g transform="translate(40 24) scale(.7) translate(-40 -24)">
  <path fill="#FFF8ED" d="M29 15L42 5L49 21Z"/>
  <path fill="#FFD0B5" d="M42 5L49 21L39 17Z"/>
  <path fill="#F39A78" d="M26 10L39 17L55 20L46 29L28 23Z"/>
  </g>
  <g fill="#303537">
    <ellipse cx="24" cy="39" rx="2.8" ry="3.8"/>
    <ellipse cx="42" cy="42" rx="2.8" ry="3.8"/>
  </g>
  <path d="M29 47Q33 51 37 48" fill="none" stroke="#303537" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
