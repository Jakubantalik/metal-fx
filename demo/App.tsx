import React, { useState } from 'react';
import { CopyButton } from './components/CopyButton';
import { Examples } from './components/Examples';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Playground } from './components/Playground';
import { useTheme } from './hooks/useTheme';
import { ReactIcon, TerminalIcon } from './components/icons';
import { highlightCode } from './lib/utils';

export function App() {
  const [theme, toggleTheme] = useTheme();
  // Strength lives on App so the Playground slider drives both the playground
  // preview AND the hero examples above. Stored as 0..100 to match the slider
  // range; consumers convert to 0..1 via `strength / 100`. Default 90% leaves
  // a bit of headroom so the metal effect feels lively without saturating the
  // ring on first paint.
  const [strength, setStrength] = useState(90);

  return (
    <main className="flex flex-col items-center max-w-[883px] mx-auto w-full px-6 pb-16 max-sm:px-4 max-sm:pb-12">
      <Header theme={theme} onToggleTheme={toggleTheme} />

      <Examples theme={theme} strength={strength / 100} />

      <section className="w-full mb-6" aria-label="Installation">
        <h2 className="text-base font-normal leading-[34px] text-(--section-title-color) mb-1">Installation</h2>
        <div className="code-explorer">
          <div className="code-header">
            <div className="code-tabs flex items-center gap-1.5 pl-1.5">
              <TerminalIcon />
              <span className="text-xs font-medium text-(--text-muted) select-none">Terminal</span>
            </div>
            <CopyButton variant="text" getText={() => 'npm install metal-fx'} />
          </div>
          <div className="code-content">
            <code className="whitespace-pre overflow-x-auto min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: highlightCode('npm install metal-fx', 'bash') }} />
          </div>
        </div>
      </section>

      <section className="w-full mb-6" aria-label="Usage">
        <h2 className="text-base font-normal leading-[34px] text-(--section-title-muted) mb-1">Usage</h2>
        <div className="code-explorer">
          <div className="code-header">
            <div className="code-tabs flex items-center gap-1.5 pl-1.5">
              <ReactIcon />
              <span className="text-xs font-medium text-(--text-muted) select-none">React</span>
            </div>
            <CopyButton variant="text" getText={() => `import { MetalFx } from 'metal-fx';\n\n<MetalFx preset="chromatic" strength={1}>\n  <button>Upgrade to Pro</button>\n</MetalFx>`} />
          </div>
          <div className="code-content">
            <pre><code className="whitespace-pre overflow-x-auto min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: highlightCode(`import { MetalFx } from 'metal-fx';\n\n<MetalFx preset="chromatic" strength={1}>\n  <button>Upgrade to Pro</button>\n</MetalFx>`, 'tsx') }} /></pre>
          </div>
        </div>
      </section>

      <Playground theme={theme} strength={strength} onStrengthChange={setStrength} />

      <Footer />
    </main>
  );
}
