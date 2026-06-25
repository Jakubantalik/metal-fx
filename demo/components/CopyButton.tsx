import React, { useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

export function CopyButton({ getText, variant = 'icon' }: { getText: () => string; variant?: 'icon' | 'text' }) {
  const [state, setState] = useState<'a' | 'b'>('a');
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleClick = () => {
    copyToClipboard(getText());
    setState('b');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('a'), 2000);
  };

  if (variant === 'text') {
    return (
      <button className="copy-btn shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-none rounded-[8px] bg-transparent cursor-pointer text-xs text-(--text-muted) transition-[background-color,color] duration-150 hover:bg-(--copy-hover) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-[rgba(255,255,255,0.5)] focus-visible:rounded-lg [&_svg]:size-3.5" type="button" data-state={state} onClick={handleClick} aria-label="Copy">
        <span className="inline-flex items-center size-3.5 relative">
          <span className="t-icon absolute inset-0 flex items-center justify-center" data-icon="a"><CopyIcon /></span>
          <span className="t-icon absolute inset-0 flex items-center justify-center" data-icon="b"><CheckIcon /></span>
        </span>
        <span className="font-inherit text-[11px] font-medium leading-[12px]">{state === 'b' ? 'Copied' : 'Copy Code'}</span>
      </button>
    );
  }

  return (
    <button className="copy-btn absolute top-0.5 right-0.5 shrink-0 inline-grid place-items-center size-9 border-none rounded-[10px] bg-transparent cursor-pointer p-0 text-inherit transition-[background-color] duration-150 hover:bg-(--copy-hover) focus-visible:outline-2 focus-visible:outline-[rgba(255,255,255,0.5)] focus-visible:outline-offset-[-2px] focus-visible:rounded-lg [&_svg]:size-4" type="button" data-state={state} onClick={handleClick} aria-label="Copy">
      <span className="t-icon" data-icon="a"><CopyIcon /></span>
      <span className="t-icon" data-icon="b"><CheckIcon /></span>
    </button>
  );
}
