// The installer's own lockup: the Kubuno mark, the wordmark, and "Setup" -
// the flow's identity, shown once at the top of every step.
//
// The viewBox is wider than the artwork's own 86 units: the file was drawn with
// Roboto Flex, and the shell's face (now really served, instead of falling back
// to Arial) sets "Setup" wider - at 86 the word was clipped on the right.
//
// Inlined rather than loaded as a file: the wizard runs before anything is
// installed, so there is no module, no font endpoint and no asset pipeline to
// rely on - only what the binary already serves. The colours go through the
// theme tokens (with the artwork's own values as fallbacks) so the mark stays
// readable on a dark skin instead of turning into black on black.

export function SetupWordmark({ height = 24 }: { height?: number }) {
  return (
    // A brand is not a sentence: it keeps its own direction whatever the page
    // reads like. Under `dir="rtl"` the wordmark came out reordered - the mark
    // landing in the middle of the letters - because the <text> runs inherited
    // the page's direction. The wrapper pins it to left-to-right and isolates
    // it from the surrounding bidi run.
    <span dir="ltr" style={{ direction: 'ltr', unicodeBidi: 'isolate', display: 'inline-flex' }}>
    <svg
      viewBox="0 0 104 12"
      height={height}
      width={(height * 104) / 12}
      overflow="visible"
      role="img"
      aria-label="kubuno Setup"
      style={{
        fillRule: 'evenodd', clipRule: 'evenodd', strokeLinejoin: 'round', strokeMiterlimit: 2,
        direction: 'ltr', unicodeBidi: 'isolate',
      }}
    >
      <clipPath id="kb-setup-mark">
        <rect x="0" y="0" width="10.281" height="11.309" />
      </clipPath>
      <g clipPath="url(#kb-setup-mark)">
        <path
          d="M0.42,0.045c-0.01,0.028 -0.01,1.505 -0.003,3.288c0.01,3.166 0.01,3.246 0.083,3.499c0.243,0.864 0.687,1.574 1.453,2.33c0.433,0.427 1.051,0.929 1.137,0.929c0.01,0 0.017,-2.268 0.014,-5.035l-0.01,-5.039l-1.328,-0.01c-1.085,-0.007 -1.328,0 -1.346,0.038Z"
          style={{ fill: 'var(--color-primary, #1a73e8)', fillRule: 'nonzero' }}
        />
        <path
          d="M3.621,0.024c-0.014,0.01 -0.024,2.358 -0.024,5.216l0,5.195l0.094,0.066c0.132,0.094 0.968,0.572 1.228,0.701l0.212,0.108l0.212,-0.111c0.118,-0.059 0.302,-0.163 0.409,-0.225c0.108,-0.066 0.208,-0.118 0.222,-0.118c0.01,0 0.09,-0.049 0.177,-0.104l0.153,-0.108l0,-2.528c0,-2.109 0.007,-2.535 0.049,-2.573c0.024,-0.024 0.388,-0.381 0.808,-0.791c0.416,-0.409 1.19,-1.165 1.72,-1.678l0.961,-0.933l-0.007,-1.061l-0.01,-1.061l-0.707,-0.01l-0.704,-0.007l-0.302,0.288c-0.163,0.163 -0.524,0.51 -0.801,0.78l-0.503,0.486l-0.035,2.074l-0.208,0.215c-0.111,0.118 -0.218,0.215 -0.232,0.215c-0.014,0 -0.031,-0.909 -0.035,-2.022l-0.01,-2.018l-1.321,-0.01c-0.725,-0.003 -1.328,0.003 -1.342,0.017Z"
          style={{ fill: 'var(--color-primary, #1a73e8)', fillRule: 'nonzero' }}
        />
        <path
          d="M7.193,5.334l-0.409,0.406l0.003,0.919l0.007,0.919l0.78,0.78l0.777,0.78l0.212,-0.222c0.461,-0.486 0.916,-1.21 1.106,-1.762l0.069,-0.201l-0.496,-0.479c-1.02,-0.985 -1.592,-1.533 -1.616,-1.54c-0.014,-0.003 -0.208,0.177 -0.433,0.399Z"
          style={{ fill: 'var(--color-primary, #1a73e8)', fillRule: 'nonzero' }}
        />
      </g>
      <g transform="matrix(1,0,0,0.956828,0,-1.826366)">
        <text
          x="12.83px"
          y="11.291px"
          style={{
            fontFamily: 'inherit', fontSize: '12px',
            fill: 'var(--color-text-primary, #292929)',
            stroke: 'var(--color-text-primary, #292929)', strokeWidth: '0.74px',
          }}
        >
          kubuno
        </text>
        <text
          x="55.3px"
          y="11.291px"
          style={{
            fontFamily: 'inherit', fontSize: '12px',
            fill: 'var(--color-text-secondary, #6c6d6e)',
            stroke: 'var(--color-text-secondary, #6c6d6e)', strokeWidth: '0.12px',
          }}
        >
          Setup
        </text>
      </g>
    </svg>
    </span>
  )
}
