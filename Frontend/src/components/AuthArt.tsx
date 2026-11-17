/** Декоративная иллюстрация для левой панели входа: щит с замком, окружённый «диалогами». Скрыта на узких экранах. */
export function AuthArt() {
  return (
    <svg className="art" viewBox="0 0 400 440" aria-hidden="true" focusable="false">
      <circle className="ring r1" cx="200" cy="220" r="184" />
      <circle className="ring r2" cx="200" cy="220" r="138" />
      <circle className="ring r3" cx="200" cy="220" r="92" />

      <path className="shield" d="M200 88l94 34v92c0 62-40 106-94 128-54-22-94-66-94-128v-92z" />
      <path className="shackle" d="M177 214v-18a23 23 0 0 1 46 0v18" />
      <rect className="lock" x="162" y="212" width="76" height="62" rx="14" />
      <circle className="hole" cx="200" cy="238" r="8" />
      <rect className="hole" x="196" y="240" width="8" height="18" rx="4" />

      <g className="float1">
        <rect className="bin" x="14" y="62" width="150" height="54" rx="18" />
        <rect className="line" x="32" y="80" width="98" height="8" rx="4" />
        <rect className="line short" x="32" y="96" width="62" height="8" rx="4" />
      </g>
      <g className="float2">
        <rect className="bout" x="240" y="340" width="146" height="54" rx="18" />
        <rect className="line" x="258" y="358" width="94" height="8" rx="4" />
        <rect className="line short" x="258" y="374" width="56" height="8" rx="4" />
      </g>
      <g className="float2">
        <circle className="badge" cx="338" cy="104" r="26" />
        <path className="tick" d="M326 104l9 9 17-18" />
      </g>

      <circle className="dot" cx="46" cy="214" r="4" />
      <circle className="dot" cx="372" cy="226" r="3" />
      <circle className="dot" cx="92" cy="386" r="3.5" />
      <circle className="dot" cx="300" cy="46" r="3" />
      <circle className="dot" cx="196" cy="418" r="3" />
    </svg>
  );
}
